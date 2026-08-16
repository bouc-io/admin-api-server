/**
 * SSO configuration types for per-org Identity Provider federation.
 * Stored as JSON in Organization.sso_config.
 *
 * Design: the discriminated union on `protocol` allows type-safe handling
 * of OIDC vs SAML config variants throughout the codebase.
 *
 * Security invariants:
 *   - client_secret_enc is AES-256-GCM encrypted (same as api_key_enc on LlmProvider)
 *   - client_secret_enc is NEVER returned to the frontend; replaced by client_secret_set: boolean
 *   - idp_alias is always derived server-side as "org-{slug}" — never writable by callers
 *   - The org_id injected into Keycloak mappers always comes from the URL :id param, never the request body
 */

export type SsoStatus = 'pending' | 'active' | 'error' | 'disabled';
export type SsoProtocol = 'oidc' | 'saml';

/**
 * Maps an IdP claim/attribute value to a Keycloak realm role.
 * Used to grant org_admin/org_admin_enterprise to specific IdP groups.
 */
export interface SsoRoleMapping {
    /** OIDC claim name (e.g. "groups") or SAML attribute name */
    claim: string;
    /** Value in the claim that triggers this mapping (e.g. "admins") */
    claim_value: string;
    /** Keycloak realm role to assign when the claim matches */
    keycloak_role: 'org_admin' | 'org_admin_enterprise' | 'org_user';
}

/**
 * OIDC IdP configuration.
 * The external IdP is federated into the Keycloak "users" realm via the Admin REST API.
 */
export interface OidcSsoConfig {
    protocol: 'oidc';
    status: SsoStatus;
    /** "org-{slug}" — derived server-side, never set by caller */
    idp_alias: string;
    /** OIDC Discovery URL: https://idp.example.com/.well-known/openid-configuration */
    discovery_url: string;
    /** OAuth2 client_id registered at the customer's IdP */
    client_id: string;
    /**
     * AES-256-GCM encrypted client_secret.
     * Format: "base64(iv):base64(authTag):base64(ciphertext)"
     * On write: caller sends plaintext; controller encrypts before persisting.
     * On read: NEVER returned to frontend — replaced with client_secret_set: boolean.
     */
    client_secret_enc: string;
    /** Space-separated additional scopes beyond "openid profile email" (e.g. "groups") */
    extra_scopes?: string;
    /** Email domain for Keycloak Home IdP Discovery (e.g. "acme.com") */
    email_domain?: string;
    /** Role mappings: IdP claim values → Keycloak realm roles */
    role_mappings?: SsoRoleMapping[];
    /** Keycloak internal UUID for this IdP — set after provisioning, used for idempotent updates */
    kc_idp_internal_id?: string;
    last_test_at?: string;
    last_test_success?: boolean;
    last_test_error?: string;
    enabled_at?: string;
    disabled_at?: string;
    updated_at: string;
}

/**
 * SAML IdP configuration.
 * Either metadata_url alone, OR the full triple (entity_id + sso_url + certificate) must be present.
 */
export interface SamlSsoConfig {
    protocol: 'saml';
    status: SsoStatus;
    /** "org-{slug}" — derived server-side, never set by caller */
    idp_alias: string;
    /** IdP Entity ID (Issuer URI) */
    entity_id: string;
    /** IdP SSO URL (HTTP-POST or HTTP-Redirect binding) */
    sso_url: string;
    /** IdP X.509 signing certificate in PEM format (-----BEGIN CERTIFICATE-----) */
    certificate: string;
    /** Optional: SAML metadata URL — Keycloak can auto-import from this */
    metadata_url?: string;
    /** NameID format: defaults to "email" if not set */
    name_id_format?: 'email' | 'persistent' | 'transient';
    email_domain?: string;
    role_mappings?: SsoRoleMapping[];
    kc_idp_internal_id?: string;
    last_test_at?: string;
    last_test_success?: boolean;
    last_test_error?: string;
    enabled_at?: string;
    disabled_at?: string;
    updated_at: string;
}

export type SsoConfig = OidcSsoConfig | SamlSsoConfig;

/**
 * What the API returns — client_secret_enc redacted, replaced by client_secret_set flag.
 */
export type OidcSsoConfigResponse = Omit<OidcSsoConfig, 'client_secret_enc'> & {
    client_secret_set: boolean;
};

export type SsoConfigResponse = OidcSsoConfigResponse | SamlSsoConfig;

/** Returned when no SSO config exists for an org */
export interface SsoNotConfiguredResponse {
    protocol: null;
    status: 'not_configured';
}

export type GetSsoConfigResponse = SsoConfigResponse | SsoNotConfiguredResponse;

/**
 * Parsed from the PUT /sso request body.
 * Callers send plaintext client_secret; the controller encrypts it.
 */
export interface OidcSsoInput {
    protocol: 'oidc';
    discovery_url: string;
    client_id: string;
    /** Plaintext on create. Omit on update to keep existing encrypted value. */
    client_secret?: string;
    extra_scopes?: string;
    email_domain?: string;
    role_mappings?: SsoRoleMapping[];
}

export interface SamlSsoInput {
    protocol: 'saml';
    entity_id: string;
    sso_url: string;
    certificate: string;
    metadata_url?: string;
    name_id_format?: 'email' | 'persistent' | 'transient';
    email_domain?: string;
    role_mappings?: SsoRoleMapping[];
}

export type SsoInput = OidcSsoInput | SamlSsoInput;

/** Tiers that are eligible to configure SSO */
export const SSO_ELIGIBLE_TIERS = ['company', 'enterprise'] as const;
