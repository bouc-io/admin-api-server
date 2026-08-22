import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getUserContextFromRequest, isBoucRole } from '../lib/auth';
import { createComponentLogger } from '../lib/logger';
import { encrypt, decrypt } from '../services/encryptionService';
import {
    SsoConfig,
    SsoInput,
    OidcSsoInput,
    SamlSsoInput,
    OidcSsoConfig,
    SamlSsoConfig,
    SsoNotConfiguredResponse,
    GetSsoConfigResponse,
    SSO_ELIGIBLE_TIERS,
} from '../types/sso';
import { keycloakAdminClient } from '../services/keycloakAdminClient';

const log = createComponentLogger('sso-controller');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidUrl(str: string): boolean {
    try {
        const url = new URL(str);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

function validateOidcInput(body: OidcSsoInput, isCreate: boolean): string | null {
    if (!body.discovery_url || !isValidUrl(body.discovery_url)) {
        return 'discovery_url must be a valid URL';
    }
    if (!body.client_id || typeof body.client_id !== 'string' || !body.client_id.trim()) {
        return 'client_id is required';
    }
    if (isCreate && (!body.client_secret || !body.client_secret.trim())) {
        return 'client_secret is required when creating an SSO configuration';
    }
    if (body.extra_scopes && !/^[a-zA-Z0-9 _:\-]+$/.test(body.extra_scopes)) {
        return 'extra_scopes contains invalid characters';
    }
    return null;
}

function validateSamlInput(body: SamlSsoInput): string | null {
    if (!body.entity_id || !isValidUrl(body.entity_id)) {
        return 'entity_id must be a valid URL';
    }
    if (!body.sso_url || !isValidUrl(body.sso_url)) {
        return 'sso_url must be a valid HTTPS URL';
    }
    if (!body.certificate || !body.certificate.trim().startsWith('-----BEGIN CERTIFICATE-----')) {
        return 'certificate must be in PEM format (starting with -----BEGIN CERTIFICATE-----)';
    }
    if (body.name_id_format && !['email', 'persistent', 'transient'].includes(body.name_id_format)) {
        return 'name_id_format must be one of: email, persistent, transient';
    }
    return null;
}

/**
 * Build the safe response (redact client_secret_enc → client_secret_set: boolean).
 */
function buildResponse(ssoConfig: SsoConfig): GetSsoConfigResponse {
    if (ssoConfig.protocol === 'oidc') {
        const { client_secret_enc, ...rest } = ssoConfig;
        return { ...rest, client_secret_set: !!client_secret_enc };
    }
    return ssoConfig;
}

/**
 * Enforce org-scope: org_admin / org_admin_enterprise can only manage their own org.
 * bouc_* staff can manage any org.
 */
function checkOrgScope(ctx: ReturnType<typeof getUserContextFromRequest>, orgId: string): boolean {
    if (!ctx) return false;
    if (isBoucRole(ctx.roles)) return true;
    return ctx.orgId === orgId;
}

// ---------------------------------------------------------------------------
// GET /v1/admin/organizations/:id/sso
// ---------------------------------------------------------------------------

export const getSsoConfig = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });

    const orgId = String(req.params.id);
    if (!checkOrgScope(ctx, orgId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
    }

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, sso_config: true } });
        if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

        const raw = org.sso_config as SsoConfig | null;
        if (!raw || !raw.protocol) {
            const notConfigured: SsoNotConfiguredResponse = { protocol: null, status: 'not_configured' };
            return res.json(notConfigured);
        }

        res.json(buildResponse(raw));
    } catch (error) {
        log.error({ err: error, orgId }, 'Failed to get SSO config');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get SSO config' } });
    }
};

// ---------------------------------------------------------------------------
// PUT /v1/admin/organizations/:id/sso
// ---------------------------------------------------------------------------

export const saveSsoConfig = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });

    const orgId = String(req.params.id);
    if (!checkOrgScope(ctx, orgId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
    }

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId } });
        if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

        // Tier guard: only company and enterprise orgs may configure SSO
        if (!SSO_ELIGIBLE_TIERS.includes(org.tier as any)) {
            return res.status(403).json({
                error: {
                    code: 'SSO_TIER_REQUIRED',
                    message: `SSO requires a company or enterprise tier. This organization is on the '${org.tier}' tier.`,
                },
            });
        }

        const body = req.body as SsoInput;
        if (!body.protocol || !['oidc', 'saml'].includes(body.protocol)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'protocol must be "oidc" or "saml"' } });
        }

        // Derive idp_alias server-side — never from request body
        const idp_alias = `org-${org.slug}`;

        // Load existing config for update scenarios
        const existing = org.sso_config as SsoConfig | null;
        const isCreate = !existing?.protocol;
        const now = new Date().toISOString();

        let newConfig: SsoConfig;

        if (body.protocol === 'oidc') {
            const validationError = validateOidcInput(body as OidcSsoInput, isCreate);
            if (validationError) {
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: validationError } });
            }
            const oidcBody = body as OidcSsoInput;

            // Encrypt client_secret. If omitted on update, preserve the existing encrypted value.
            let client_secret_enc: string;
            if (oidcBody.client_secret) {
                client_secret_enc = encrypt(oidcBody.client_secret);
            } else if (existing?.protocol === 'oidc' && existing.client_secret_enc) {
                client_secret_enc = existing.client_secret_enc;
            } else {
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'client_secret is required' } });
            }

            newConfig = {
                protocol: 'oidc',
                status: 'pending',
                idp_alias,
                discovery_url: oidcBody.discovery_url,
                client_id: oidcBody.client_id,
                client_secret_enc,
                extra_scopes: oidcBody.extra_scopes,
                email_domain: oidcBody.email_domain,
                role_mappings: oidcBody.role_mappings,
                kc_idp_internal_id: (existing as OidcSsoConfig | null)?.kc_idp_internal_id,
                updated_at: now,
            } as OidcSsoConfig;
        } else {
            const validationError = validateSamlInput(body as SamlSsoInput);
            if (validationError) {
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: validationError } });
            }
            const samlBody = body as SamlSsoInput;

            newConfig = {
                protocol: 'saml',
                status: 'pending',
                idp_alias,
                entity_id: samlBody.entity_id,
                sso_url: samlBody.sso_url,
                certificate: samlBody.certificate,
                metadata_url: samlBody.metadata_url,
                name_id_format: samlBody.name_id_format,
                email_domain: samlBody.email_domain,
                role_mappings: samlBody.role_mappings,
                kc_idp_internal_id: (existing as SamlSsoConfig | null)?.kc_idp_internal_id,
                updated_at: now,
            } as SamlSsoConfig;
        }

        // Persist with status: "pending" first
        await prisma.organization.update({ where: { id: orgId }, data: { sso_config: newConfig as any } });
        log.info({ orgId, protocol: body.protocol, isCreate }, 'SSO config saved (pending Keycloak provisioning)');

        // Provision in Keycloak
        try {
            const kcInternalId = await keycloakAdminClient.provisionIdp(
                { id: orgId, slug: org.slug, name: org.name },
                newConfig,
            );
            newConfig = { ...newConfig, status: 'active', kc_idp_internal_id: kcInternalId } as SsoConfig;
            await prisma.organization.update({ where: { id: orgId }, data: { sso_config: { ...newConfig, enabled_at: now } as any } });
            log.info({ orgId, idp_alias, kcInternalId }, 'Keycloak IdP provisioned successfully');
        } catch (kcError: any) {
            const errMsg = kcError?.message || 'Keycloak provisioning failed';
            log.error({ err: kcError, orgId, idp_alias }, 'Keycloak provisioning failed');
            newConfig = { ...newConfig, status: 'error', last_test_error: errMsg, last_test_at: now } as SsoConfig;
            await prisma.organization.update({ where: { id: orgId }, data: { sso_config: newConfig as any } });
            return res.status(422).json({
                error: { code: 'KEYCLOAK_PROVISIONING_FAILED', message: errMsg },
                sso: buildResponse(newConfig),
            });
        }

        res.json(buildResponse(newConfig));
    } catch (error) {
        log.error({ err: error }, 'Failed to save SSO config');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save SSO config' } });
    }
};

// ---------------------------------------------------------------------------
// POST /v1/admin/organizations/:id/sso/test
// ---------------------------------------------------------------------------

export const testSsoConnection = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });

    const orgId = String(req.params.id);
    if (!checkOrgScope(ctx, orgId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
    }

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { sso_config: true } });
        if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

        const ssoConfig = org.sso_config as SsoConfig | null;
        if (!ssoConfig?.protocol) {
            return res.status(400).json({ error: { code: 'NOT_CONFIGURED', message: 'No SSO configuration found. Save a configuration first.' } });
        }

        const result = await keycloakAdminClient.testIdpConnectivity(ssoConfig);

        // Persist test result
        const now = new Date().toISOString();
        const updated: SsoConfig = {
            ...ssoConfig,
            last_test_at: now,
            last_test_success: result.success,
            last_test_error: result.success ? undefined : result.message,
        } as SsoConfig;
        await prisma.organization.update({ where: { id: orgId }, data: { sso_config: updated as any } });

        res.json(result);
    } catch (error) {
        log.error({ err: error, orgId }, 'Failed to test SSO connection');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to test SSO connection' } });
    }
};

// ---------------------------------------------------------------------------
// POST /v1/admin/organizations/:id/sso/enable
// ---------------------------------------------------------------------------

export const enableSso = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });

    const orgId = String(req.params.id);
    if (!checkOrgScope(ctx, orgId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
    }

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { sso_config: true } });
        if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

        const ssoConfig = org.sso_config as SsoConfig | null;
        if (!ssoConfig?.protocol || !ssoConfig.idp_alias) {
            return res.status(400).json({ error: { code: 'NOT_CONFIGURED', message: 'No SSO configuration found' } });
        }

        await keycloakAdminClient.setIdentityProviderEnabled(ssoConfig.idp_alias, true);

        const now = new Date().toISOString();
        // On successful enable, clear stale error state from prior failures.
        const updated: SsoConfig = {
            ...ssoConfig,
            status: 'active',
            enabled_at: now,
            disabled_at: undefined,
            last_test_error: undefined,
        } as SsoConfig;
        await prisma.organization.update({ where: { id: orgId }, data: { sso_config: updated as any } });

        log.info({ orgId, idp_alias: ssoConfig.idp_alias }, 'SSO enabled');
        res.json({ status: 'active', enabled_at: now });
    } catch (error) {
        log.error({ err: error, orgId }, 'Failed to enable SSO');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to enable SSO' } });
    }
};

// ---------------------------------------------------------------------------
// POST /v1/admin/organizations/:id/sso/disable
// ---------------------------------------------------------------------------

export const disableSso = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });

    const orgId = String(req.params.id);
    if (!checkOrgScope(ctx, orgId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
    }

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { sso_config: true } });
        if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

        const ssoConfig = org.sso_config as SsoConfig | null;
        if (!ssoConfig?.protocol || !ssoConfig.idp_alias) {
            return res.status(400).json({ error: { code: 'NOT_CONFIGURED', message: 'No SSO configuration found' } });
        }

        await keycloakAdminClient.setIdentityProviderEnabled(ssoConfig.idp_alias, false);

        const now = new Date().toISOString();
        const updated: SsoConfig = { ...ssoConfig, status: 'disabled', disabled_at: now } as SsoConfig;
        await prisma.organization.update({ where: { id: orgId }, data: { sso_config: updated as any } });

        log.info({ orgId, idp_alias: ssoConfig.idp_alias }, 'SSO disabled');
        res.json({ status: 'disabled', disabled_at: now });
    } catch (error) {
        log.error({ err: error, orgId }, 'Failed to disable SSO');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to disable SSO' } });
    }
};

// ---------------------------------------------------------------------------
// DELETE /v1/admin/organizations/:id/sso
// ---------------------------------------------------------------------------

export const deleteSsoConfig = async (req: Request, res: Response) => {
    const ctx = getUserContextFromRequest(req);
    if (!ctx) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });

    const orgId = String(req.params.id);
    if (!checkOrgScope(ctx, orgId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access restricted to your organization' } });
    }

    try {
        const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { sso_config: true } });
        if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

        const ssoConfig = org.sso_config as SsoConfig | null;

        // Remove from Keycloak if provisioned
        if (ssoConfig?.idp_alias) {
            try {
                await keycloakAdminClient.deleteIdentityProvider(ssoConfig.idp_alias);
                log.info({ orgId, idp_alias: ssoConfig.idp_alias }, 'Keycloak IdP deleted');
            } catch (kcError: any) {
                // If IdP doesn't exist in Keycloak, still clear the DB config
                if (!kcError?.message?.includes('404')) {
                    log.error({ err: kcError, orgId }, 'Failed to delete Keycloak IdP');
                    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to remove SSO from identity provider' } });
                }
                log.warn({ orgId, idp_alias: ssoConfig.idp_alias }, 'Keycloak IdP not found during delete — clearing DB config anyway');
            }
        }

        await prisma.organization.update({ where: { id: orgId }, data: { sso_config: {} as any } });
        log.info({ orgId }, 'SSO config deleted');
        res.status(204).send();
    } catch (error) {
        log.error({ err: error, orgId }, 'Failed to delete SSO config');
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete SSO config' } });
    }
};
