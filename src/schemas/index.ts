import { z } from 'zod';

/**
 * Request body schemas for admin-api-server mutating routes.
 * Objects use .passthrough() so unknown keys are preserved while known fields
 * are type-checked. Apply with the validate() middleware.
 */

const metadata = z.record(z.string(), z.unknown());
const priority = z.union([z.number(), z.string()]).optional();

export const createProviderSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    provider: z.string().min(1, 'provider is required'),
    api_endpoint: z.string().optional(),
    api_key: z.string().optional(),
    models: z.array(z.unknown()).optional(),
    is_active: z.boolean().optional(),
    org_id: z.string().nullable().optional(),
  })
  .passthrough();

export const updateProviderSchema = z
  .object({
    name: z.string().optional(),
    provider: z.string().optional(),
    api_endpoint: z.string().optional(),
    api_key: z.string().optional(),
    models: z.array(z.unknown()).optional(),
    is_active: z.boolean().optional(),
  })
  .passthrough();

export const createMcpServerSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    url: z.string().url('url must be a valid URL'),
    transport: z.enum(['http', 'sse']).optional(),
    auth_token: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

export const updateMcpServerSchema = z
  .object({
    name: z.string().min(1).optional(),
    url: z.string().url('url must be a valid URL').optional(),
    transport: z.enum(['http', 'sse']).optional(),
    auth_token: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

export const addMemberSchema = z
  .object({
    user_id: z.string().optional(),
    email: z.string().optional(),
    role: z.string().min(1, 'role is required'),
  })
  .passthrough();

export const updateMemberSchema = z
  .object({ role: z.string().min(1, 'role is required') })
  .passthrough();

export const createOrganizationSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    slug: z.string().min(1, 'slug is required'),
    tier: z.string().optional(),
    status: z.string().optional(),
    sso_config: metadata.optional(),
  })
  .passthrough();

export const updateOrganizationSchema = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
    tier: z.string().optional(),
    status: z.string().optional(),
    sso_config: metadata.optional(),
  })
  .passthrough();

export const updateLlmAssignmentSchema = z
  .object({
    providerId: z.string().min(1, 'providerId is required'),
    model: z.string().optional(),
    enableReasoning: z.boolean().optional(),
    org_id: z.string().nullable().optional(),
  })
  .passthrough();

export const createInstructionSchema = z
  .object({
    title: z.string().min(1, 'title is required'),
    content: z.string().min(1, 'content is required'),
    priority,
    is_active: z.boolean().optional(),
    org_id: z.string().nullable().optional(),
  })
  .passthrough();

export const updateInstructionSchema = z
  .object({
    title: z.string().optional(),
    content: z.string().optional(),
    priority,
    is_active: z.boolean().optional(),
  })
  .passthrough();

// SSO config payload shape is provider-specific; validate that it is an object.
export const saveSsoConfigSchema = z.object({}).passthrough();
