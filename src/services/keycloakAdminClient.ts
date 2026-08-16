import axios from 'axios';
import { createComponentLogger } from '../lib/logger';
import { decrypt } from './encryptionService';
import { SsoConfig, OidcSsoConfig, SamlSsoConfig, SsoRoleMapping } from '../types/sso';

const log = createComponentLogger('keycloak-admin-client');

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

function getConfig() {
    return {
        adminUrl:      process.env.KEYCLOAK_ADMIN_URL     || '',
        realm:         process.env.KEYCLOAK_REALM         || 'users',
        adminUser:     process.env.KEYCLOAK_ADMIN_USER    || '',
        adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || '',
        grantType:     (process.env.KEYCLOAK_ADMIN_GRANT_TYPE || 'password') as 'password' | 'client_credentials',
    };
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

interface TokenCache {
    token: string;
    expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface KeycloakIdpConfig {
    alias: string;
    displayName: string;
    providerId: 'oidc' | 'saml';
    enabled: boolean;
    trustEmail: boolean;
    storeToken: boolean;
    addReadTokenRoleOnCreate: boolean;
    authenticateByDefault: boolean;
    linkOnly: boolean;
    config: Record<string, string>;
}

interface KeycloakIdpMapper {
    id?: string;
    name: string;
    identityProviderMapper: string;
    identityProviderAlias: string;
    config: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Keycloak Admin Client class
// ---------------------------------------------------------------------------

class KeycloakAdminClient {

    // -----------------------------------------------------------------------
    // Authentication
    // -----------------------------------------------------------------------

    /**
     * Get a cached admin access token, refreshing if within 60s of expiry.
     */
    async getAdminToken(): Promise<string> {
        const now = Date.now();
        if (tokenCache && tokenCache.expiresAt - now > 60_000) {
            return tokenCache.token;
        }

        const cfg = getConfig();
        if (!cfg.adminUrl) throw new Error('KEYCLOAK_ADMIN_URL is not configured');
        if (!cfg.adminUser) throw new Error('KEYCLOAK_ADMIN_USER is not configured');
        if (!cfg.adminPassword) throw new Error('KEYCLOAK_ADMIN_PASSWORD is not configured');

        const tokenUrl = `${cfg.adminUrl}/realms/master/protocol/openid-connect/token`;

        const params = new URLSearchParams({
            grant_type: 'password',
            client_id: 'admin-cli',
            username: cfg.adminUser,
            password: cfg.adminPassword,
        });

        try {
            const resp = await axios.post(tokenUrl, params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10_000,
            });
            const { access_token, expires_in } = resp.data;
            tokenCache = {
                token: access_token,
                expiresAt: now + (expires_in * 1000),
            };
            log.debug({ expiresIn: expires_in }, 'Keycloak admin token refreshed');
            return access_token;
        } catch (err: any) {
            const detail = err?.response?.data?.error_description || err?.message;
            log.error({ err: detail }, 'Failed to get Keycloak admin token');
            throw new Error(`Keycloak admin authentication failed: ${detail}`);
        }
    }

    private async authHeaders(): Promise<Record<string, string>> {
        const token = await this.getAdminToken();
        return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    }

    private realmBase(): string {
        const { adminUrl, realm } = getConfig();
        return `${adminUrl}/admin/realms/${realm}`;
    }

    // -----------------------------------------------------------------------
    // Identity Provider management
    // -----------------------------------------------------------------------

    /**
     * Create an Identity Provider in the Keycloak realm.
     * Returns the Keycloak-assigned internal UUID.
     */
    async createIdentityProvider(idpConfig: KeycloakIdpConfig): Promise<string> {
        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/identity-provider/instances`;

        try {
            const resp = await axios.post(url, idpConfig, { headers, timeout: 15_000 });
            // Keycloak returns 201 with Location header: .../identity-provider/instances/{alias}
            // The internal UUID is not exposed directly on create; fetch it by alias.
            const created = await this.getIdentityProvider(idpConfig.alias);
            log.info({ alias: idpConfig.alias, internalId: created.internalId }, 'Keycloak IdP created');
            return created.internalId;
        } catch (err: any) {
            const detail = err?.response?.data?.errorMessage || err?.response?.data?.error || err?.message;
            log.error({ err: detail, alias: idpConfig.alias }, 'Failed to create Keycloak IdP');
            throw new Error(`Failed to create IdP '${idpConfig.alias}': ${detail}`);
        }
    }

    /**
     * Fetch an IdP by alias — used to get the internal UUID after creation.
     */
    private async getIdentityProvider(alias: string): Promise<{ internalId: string; enabled: boolean }> {
        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/identity-provider/instances/${alias}`;
        const resp = await axios.get(url, { headers, timeout: 10_000 });
        return { internalId: resp.data.internalId, enabled: resp.data.enabled };
    }

    /**
     * Fetch the full raw IdP representation (including providerId) — used to detect protocol switches.
     */
    private async getIdentityProviderRaw(alias: string): Promise<{ internalId: string; enabled: boolean; providerId: string }> {
        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/identity-provider/instances/${alias}`;
        const resp = await axios.get(url, { headers, timeout: 10_000 });
        return { internalId: resp.data.internalId, enabled: resp.data.enabled, providerId: resp.data.providerId };
    }

    /**
     * Update an existing IdP by alias.
     */
    async updateIdentityProvider(alias: string, idpConfig: Partial<KeycloakIdpConfig>): Promise<void> {
        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/identity-provider/instances/${alias}`;
        try {
            await axios.put(url, idpConfig, { headers, timeout: 15_000 });
            log.info({ alias }, 'Keycloak IdP updated');
        } catch (err: any) {
            const detail = err?.response?.data?.errorMessage || err?.response?.data?.error || err?.message;
            log.error({ err: detail, alias }, 'Failed to update Keycloak IdP');
            throw new Error(`Failed to update IdP '${alias}': ${detail}`);
        }
    }

    /**
     * Delete an IdP and all its mappers.
     */
    async deleteIdentityProvider(alias: string): Promise<void> {
        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/identity-provider/instances/${alias}`;
        try {
            await axios.delete(url, { headers, timeout: 10_000 });
            log.info({ alias }, 'Keycloak IdP deleted');
        } catch (err: any) {
            if (err?.response?.status === 404) {
                log.warn({ alias }, 'Keycloak IdP not found — already deleted');
                return;
            }
            const detail = err?.response?.data?.errorMessage || err?.message;
            throw new Error(`Failed to delete IdP '${alias}': ${detail}`);
        }
    }

    /**
     * Enable or disable an IdP.
     */
    async setIdentityProviderEnabled(alias: string, enabled: boolean): Promise<void> {
        // Fetch current config to merge
        const headers = await this.authHeaders();
        const getUrl = `${this.realmBase()}/identity-provider/instances/${alias}`;
        const current = await axios.get(getUrl, { headers, timeout: 10_000 });
        await this.updateIdentityProvider(alias, { ...current.data, enabled });
        log.info({ alias, enabled }, 'Keycloak IdP enabled state changed');
    }

    // -----------------------------------------------------------------------
    // IdP Mappers
    // -----------------------------------------------------------------------

    /**
     * List all mappers for an IdP.
     */
    async listIdpMappers(alias: string): Promise<KeycloakIdpMapper[]> {
        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/identity-provider/instances/${alias}/mappers`;
        try {
            const resp = await axios.get(url, { headers, timeout: 10_000 });
            return resp.data as KeycloakIdpMapper[];
        } catch (err: any) {
            if (err?.response?.status === 404) return [];
            throw err;
        }
    }

    /**
     * Upsert mappers: list existing → diff → create/update/delete.
     * Mappers are identified by name — names must be deterministic.
     */
    async upsertIdpMappers(alias: string, desired: KeycloakIdpMapper[]): Promise<void> {
        const headers = await this.authHeaders();
        const base = `${this.realmBase()}/identity-provider/instances/${alias}/mappers`;

        const existing = await this.listIdpMappers(alias);
        const existingByName = new Map(existing.map(m => [m.name, m]));
        const desiredNames = new Set(desired.map(m => m.name));

        // Create or update desired mappers
        for (const mapper of desired) {
            const existingMapper = existingByName.get(mapper.name);
            if (existingMapper?.id) {
                await axios.put(`${base}/${existingMapper.id}`, { ...mapper, id: existingMapper.id }, { headers, timeout: 10_000 });
                log.debug({ alias, mapperName: mapper.name }, 'Keycloak IdP mapper updated');
            } else {
                await axios.post(base, mapper, { headers, timeout: 10_000 });
                log.debug({ alias, mapperName: mapper.name }, 'Keycloak IdP mapper created');
            }
        }

        // Delete mappers that are no longer desired (only those we manage — prefix "org-{alias}-")
        for (const [name, mapper] of existingByName) {
            if (name.startsWith(`${alias}-`) && !desiredNames.has(name) && mapper.id) {
                await axios.delete(`${base}/${mapper.id}`, { headers, timeout: 10_000 });
                log.debug({ alias, mapperName: name }, 'Keycloak IdP mapper deleted (no longer desired)');
            }
        }
    }

    // -----------------------------------------------------------------------
    // User attribute management (for Path C: admin adds user to org)
    // -----------------------------------------------------------------------

    /**
     * Find a Keycloak user's internal UUID.
     * Tries the value as preferred_username first (the common case — userId in our DB
     * equals Keycloak preferred_username). If that misses and the value looks like an
     * email, falls back to an email lookup. Both use exact=true to avoid substring matches.
     */
    async findKeycloakUserId(identifier: string): Promise<string | null> {
        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/users`;
        try {
            // First try: username lookup (the expected path)
            const byUsername = await axios.get(url, {
                headers,
                params: { username: identifier, exact: true },
                timeout: 10_000,
            });
            const usernameHits = byUsername.data as Array<{ id: string; username: string }>;
            if (usernameHits.length > 0) return usernameHits[0].id;

            // Fallback: if identifier looks like an email, try email lookup
            if (identifier.includes('@')) {
                const byEmail = await axios.get(url, {
                    headers,
                    params: { email: identifier, exact: true },
                    timeout: 10_000,
                });
                const emailHits = byEmail.data as Array<{ id: string; username: string; email: string }>;
                if (emailHits.length > 0) {
                    log.info({ identifier, kcUserId: emailHits[0].id }, 'Resolved Keycloak user via email fallback');
                    return emailHits[0].id;
                }
            }

            return null;
        } catch (err: any) {
            log.error({ err: err?.message, identifier }, 'Failed to look up Keycloak user');
            return null;
        }
    }

    /**
     * Set the org_id user attribute on a Keycloak user.
     * Called when an admin adds a user to an org via POST /organizations/:id/members.
     * Token staleness note: the change takes effect on the user's next token refresh.
     */
    async setUserOrgAttribute(username: string, orgId: string): Promise<void> {
        const kcUserId = await this.findKeycloakUserId(username);
        if (!kcUserId) {
            log.warn({ username }, 'Keycloak user not found — org_id attribute not set');
            return;
        }

        const headers = await this.authHeaders();
        const url = `${this.realmBase()}/users/${kcUserId}`;

        // Fetch current user to merge attributes (avoid overwriting other attributes)
        const current = await axios.get(url, { headers, timeout: 10_000 });
        const currentAttrs = current.data.attributes || {};

        await axios.put(url, {
            ...current.data,
            attributes: { ...currentAttrs, org_id: [orgId] },
        }, { headers, timeout: 10_000 });

        log.info({ username, kcUserId, orgId }, 'Keycloak user org_id attribute updated');
    }

    // -----------------------------------------------------------------------
    // Connectivity test
    // -----------------------------------------------------------------------

    /**
     * Test IdP connectivity by directly fetching the discovery document (OIDC)
     * or metadata URL (SAML). No Keycloak round-trip — pure HTTP probe.
     */
    async testIdpConnectivity(ssoConfig: SsoConfig): Promise<{
        success: boolean;
        message: string;
        details?: Record<string, unknown>;
    }> {
        if (ssoConfig.protocol === 'oidc') {
            const url = ssoConfig.discovery_url;
            try {
                const resp = await axios.get(url, { timeout: 10_000, maxRedirects: 3 });
                const data = resp.data;
                if (!data.issuer || !data.token_endpoint) {
                    return { success: false, message: 'Discovery document missing required fields (issuer, token_endpoint)', details: data };
                }
                return {
                    success: true,
                    message: 'OIDC discovery endpoint reachable; token endpoint confirmed.',
                    details: { issuer: data.issuer, token_endpoint: data.token_endpoint },
                };
            } catch (err: any) {
                const status = err?.response?.status;
                return {
                    success: false,
                    message: `Failed to reach OIDC discovery URL: ${err?.message}`,
                    details: { http_status: status },
                };
            }
        }

        if (ssoConfig.protocol === 'saml') {
            const url = ssoConfig.metadata_url || ssoConfig.sso_url;
            try {
                await axios.get(url, { timeout: 10_000, maxRedirects: 3 });
                return { success: true, message: 'SAML metadata/SSO URL reachable.', details: { url } };
            } catch (err: any) {
                return {
                    success: false,
                    message: `Failed to reach SAML URL: ${err?.message}`,
                    details: { url },
                };
            }
        }

        return { success: false, message: 'Unknown SSO protocol' };
    }

    // -----------------------------------------------------------------------
    // Full IdP provisioning (create/update + mappers)
    // -----------------------------------------------------------------------

    /**
     * Full upsert: create or update the IdP in Keycloak, then upsert the three standard mappers.
     * Returns the Keycloak internal UUID for the IdP.
     *
     * Mappers created:
     *   1. hardcoded-role-idp-mapper → org_user (all SSO users, FORCE)
     *   2. oidc-role-idp-mapper per role_mappings[] entry (FORCE)
     *   3. hardcoded-attribute-idp-mapper → org_id = orgId (FORCE)
     *
     * Security: org_id value comes from the org.id param, never from the request body.
     */
    async provisionIdp(
        org: { id: string; slug: string; name: string },
        ssoConfig: SsoConfig,
    ): Promise<string> {
        const alias = ssoConfig.idp_alias;

        // Build Keycloak IdP config
        const idpConfig = this.buildIdpConfig(org, ssoConfig);

        // Upsert IdP: check if it already exists by alias
        let kcInternalId: string;
        let existingProviderId: string | undefined;
        try {
            const existingRaw = await this.getIdentityProviderRaw(alias);
            existingProviderId = existingRaw.providerId;
        } catch (err: any) {
            if (!(err?.response?.status === 404 || err?.message?.includes('404'))) throw err;
        }

        if (existingProviderId && existingProviderId !== ssoConfig.protocol) {
            // Protocol switched (oidc ↔ saml) — Keycloak won't let us PUT a new providerId on an existing IdP.
            // Delete-then-create to avoid a 400 from Keycloak.
            log.info({ alias, from: existingProviderId, to: ssoConfig.protocol }, 'Protocol switch detected; deleting existing IdP before recreate');
            await this.deleteIdentityProvider(alias);
            kcInternalId = await this.createIdentityProvider(idpConfig);
        } else if (existingProviderId) {
            await this.updateIdentityProvider(alias, idpConfig);
            const refreshed = await this.getIdentityProvider(alias);
            kcInternalId = refreshed.internalId;
        } else {
            kcInternalId = await this.createIdentityProvider(idpConfig);
        }

        // Build standard mappers (protocol-aware: OIDC vs SAML use different mapper types and config keys)
        const mappers = this.buildMappers(alias, org.id, ssoConfig.protocol, ssoConfig.role_mappings || []);
        await this.upsertIdpMappers(alias, mappers);

        return kcInternalId;
    }

    // -----------------------------------------------------------------------
    // Private builder helpers
    // -----------------------------------------------------------------------

    private buildIdpConfig(
        org: { id: string; slug: string; name: string },
        ssoConfig: SsoConfig,
    ): KeycloakIdpConfig {
        const base: Omit<KeycloakIdpConfig, 'config'> = {
            alias: ssoConfig.idp_alias,
            displayName: org.name,
            providerId: ssoConfig.protocol,
            enabled: true,
            trustEmail: true,       // Trust IdP's email-verified claim
            storeToken: false,      // Don't store upstream IdP tokens
            addReadTokenRoleOnCreate: false,
            authenticateByDefault: false,
            linkOnly: false,        // Allow JIT user account creation
        };

        if (ssoConfig.protocol === 'oidc') {
            const oidc = ssoConfig as OidcSsoConfig;
            const plainSecret = decrypt(oidc.client_secret_enc);
            const scopes = ['openid', 'profile', 'email', ...(oidc.extra_scopes?.split(' ').filter(Boolean) || [])].join(' ');

            return {
                ...base,
                config: {
                    clientId: oidc.client_id,
                    clientSecret: plainSecret,
                    defaultScope: scopes,
                    discoveryEndpoint: oidc.discovery_url,
                    useJwksUrl: 'true',
                    validateSignature: 'true',
                    pkceEnabled: 'false',
                    syncMode: 'FORCE',
                    ...(oidc.email_domain && { loginHint: oidc.email_domain }),
                },
            };
        } else {
            const saml = ssoConfig as SamlSsoConfig;
            return {
                ...base,
                config: {
                    entityId: saml.entity_id,
                    singleSignOnServiceUrl: saml.sso_url,
                    signingCertificate: saml.certificate
                        .replace(/-----BEGIN CERTIFICATE-----/g, '')
                        .replace(/-----END CERTIFICATE-----/g, '')
                        .replace(/\s/g, ''),
                    nameIDPolicyFormat: this.samlNameIdFormat(saml.name_id_format),
                    postBindingResponse: 'true',
                    postBindingAuthnRequest: 'true',
                    validateSignature: 'true',
                    wantAuthnRequestsSigned: 'false',
                    syncMode: 'FORCE',
                    ...(saml.metadata_url && { metadataDescriptorUrl: saml.metadata_url }),
                    ...(saml.email_domain && { loginHint: saml.email_domain }),
                },
            };
        }
    }

    private samlNameIdFormat(format?: string): string {
        switch (format) {
            case 'persistent': return 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
            case 'transient':  return 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
            case 'email':
            default:           return 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
        }
    }

    private buildMappers(
        alias: string,
        orgId: string,
        protocol: 'oidc' | 'saml',
        roleMappings: SsoRoleMapping[],
    ): KeycloakIdpMapper[] {
        const mappers: KeycloakIdpMapper[] = [];

        // Mapper 1: All SSO users → org_user (hardcoded, FORCE)
        mappers.push({
            name: `${alias}-default-role`,
            identityProviderMapper: 'hardcoded-role-idp-mapper',
            identityProviderAlias: alias,
            config: {
                role: 'org_user',
                syncMode: 'FORCE',
            },
        });

        // Mapper 2: Claim/attribute-based role mappers from role_mappings[] (FORCE).
        // OIDC and SAML use different Keycloak mapper types and config keys:
        //   OIDC → "oidc-role-idp-mapper" with "claim" / "claim.value"
        //   SAML → "saml-role-idp-mapper" with "attribute.name" / "attribute.value"
        roleMappings.forEach((mapping, i) => {
            if (protocol === 'oidc') {
                mappers.push({
                    name: `${alias}-role-mapping-${i}`,
                    identityProviderMapper: 'oidc-role-idp-mapper',
                    identityProviderAlias: alias,
                    config: {
                        claim: mapping.claim,
                        'claim.value': mapping.claim_value,
                        role: mapping.keycloak_role,
                        syncMode: 'FORCE',
                    },
                });
            } else {
                mappers.push({
                    name: `${alias}-role-mapping-${i}`,
                    identityProviderMapper: 'saml-role-idp-mapper',
                    identityProviderAlias: alias,
                    config: {
                        'attribute.name': mapping.claim,
                        'attribute.value': mapping.claim_value,
                        role: mapping.keycloak_role,
                        syncMode: 'FORCE',
                    },
                });
            }
        });

        // Mapper 3: Hardcode org_id attribute — value always from org.id, never from request body (security invariant)
        mappers.push({
            name: `${alias}-org-id`,
            identityProviderMapper: 'hardcoded-attribute-idp-mapper',
            identityProviderAlias: alias,
            config: {
                attribute: 'org_id',
                'attribute.value': orgId,
                syncMode: 'FORCE',
            },
        });

        return mappers;
    }
}

// Singleton export
export const keycloakAdminClient = new KeycloakAdminClient();
