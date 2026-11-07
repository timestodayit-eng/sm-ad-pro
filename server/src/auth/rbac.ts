/**
 * Roles and permissions. Enforced on the server for every route and, later, every AI tool.
 * Account-level access is checked separately (user_account_access, or users.all_accounts).
 */
export const ROLES = ['super_admin', 'admin', 'media_buyer', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'settings.manage',
  'users.manage',
  'schema.migrate',
  'audit.read',
  'meta.connect',
  'accounts.read',
  'accounts.manage',
  'jobs.read',
  'jobs.manage',
  'health.read',
  'campaigns.draft',
  'campaigns.publish',
  'campaigns.activate',
  'campaigns.manage',
  'reports.read',
  'reports.manage',
  'ai.use',
  'media.read',
  'media.upload',
  'media.delete',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: ALL,
  admin: ALL.filter((p) => p !== 'schema.migrate'),
  media_buyer: [
    'accounts.read', 'jobs.read', 'health.read', 'campaigns.draft', 'campaigns.publish',
    'campaigns.manage', 'reports.read', 'reports.manage', 'ai.use', 'media.read', 'media.upload', 'media.delete',
  ],
  analyst: ['accounts.read', 'jobs.read', 'health.read', 'campaigns.draft', 'reports.read', 'reports.manage', 'ai.use', 'media.read'],
  viewer: ['accounts.read', 'health.read', 'reports.read', 'media.read'],
};

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  media_buyer: 'Media Buyer',
  analyst: 'Analyst',
  viewer: 'Viewer',
};

export function can(role: string, perm: Permission): boolean {
  return (ROLE_PERMISSIONS as Record<string, readonly Permission[]>)[role]?.includes(perm) ?? false;
}

export function permissionsFor(role: string): Permission[] {
  return [...((ROLE_PERMISSIONS as Record<string, readonly Permission[]>)[role] ?? [])];
}
