import { supabase } from "@/integrations/supabase/client";

// Core sync engine types
export interface SyncRecord {
  email: string;
  a_data: Record<string, any>;
  b_data: Record<string, any>;
  updated_at: string;
}

export interface FieldConflict {
  field: string;
  a_value: any;
  b_value: any;
  a_updated_at?: string;
  b_updated_at?: string;
}

export interface SyncResult {
  action: 'skip' | 'update_a' | 'update_b' | 'conflict';
  field: string;
  direction?: 'A→B' | 'B→A';
  conflict?: FieldConflict;
}

// Field mappings for clients table
export const CLIENT_FIELD_MAPPINGS = {
  'first_name': 'firstName',
  'last_name': 'lastName', 
  'email': 'email',
  'phone': 'phone',
  'city': 'city',
  'country': 'country',
  'birth_date': 'birthDate',
  'gender': 'gender'
};

/**
 * Normalize field values for comparison
 */
export function normalizeValue(value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed.toLowerCase();
  }
  return value;
}

/**
 * Compare two values to determine if they're effectively equal
 */
export function valuesEqual(a: any, b: any): boolean {
  const normA = normalizeValue(a);
  const normB = normalizeValue(b);
  return normA === normB;
}

/**
 * Detect changes between current state and shadow state
 */
export function detectChanges(
  current: Record<string, any>, 
  shadow: Record<string, any>
): string[] {
  const changedFields: string[] = [];
  
  for (const field in current) {
    if (!valuesEqual(current[field], shadow[field])) {
      changedFields.push(field);
    }
  }
  
  return changedFields;
}

/**
 * Core sync decision logic for a single field
 * Implements "non-empty overwrites empty" rule
 */
export function decideSyncAction(
  field: string,
  aValue: any,
  bValue: any,
  shadowA: any,
  shadowB: any
): SyncResult {
  // Normalize all values
  const normA = normalizeValue(aValue);
  const normB = normalizeValue(bValue);
  const normShadowA = normalizeValue(shadowA);
  const normShadowB = normalizeValue(shadowB);

  // Check if values changed from shadow
  const aChanged = !valuesEqual(normA, normShadowA);
  const bChanged = !valuesEqual(normB, normShadowB);

  // Decision tree
  if (!aChanged && !bChanged) {
    return { action: 'skip', field };
  }

  if (aChanged && !bChanged) {
    return { action: 'update_b', field, direction: 'A→B' };
  }

  if (!aChanged && bChanged) {
    return { action: 'update_a', field, direction: 'B→A' };
  }

  // Both changed - check if values are equal
  if (valuesEqual(normA, normB)) {
    return { action: 'skip', field }; // Same value, just update shadow
  }

  // Both changed, different values - apply "non-empty overwrites empty" rule
  if (normA === null && normB !== null) {
    return { action: 'update_a', field, direction: 'B→A' };
  }

  if (normA !== null && normB === null) {
    return { action: 'update_b', field, direction: 'A→B' };
  }

  // Both non-empty and different - conflict
  return {
    action: 'conflict',
    field,
    conflict: {
      field,
      a_value: aValue,
      b_value: bValue
    }
  };
}

/**
 * Email normalization helper
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Get shadow state from database
 */
export async function getShadowState(email: string): Promise<{
  aData: Record<string, any>;
  bData: Record<string, any>;
} | null> {
  try {
    const { data, error } = await supabase
      .from('sync_shadow')
      .select('snapshot')
      .eq('email', normalizeEmail(email))
      .maybeSingle();

    if (error) {
      console.error('Failed to get shadow state:', error);
      return null;
    }

    if (!data?.snapshot) {
      return { aData: {}, bData: {} }; // Return empty if no shadow exists
    }

    const snapshot = data.snapshot as any;
    return {
      aData: snapshot.a || {},
      bData: snapshot.b || {}
    };
  } catch (error) {
    console.error('Failed to get shadow state:', error);
    return { aData: {}, bData: {} };
  }
}

/**
 * Update shadow state in database
 */
export async function updateShadowState(
  email: string,
  aData: Record<string, any>,
  bData: Record<string, any>
): Promise<void> {
  try {
    const snapshot = {
      a: aData,
      b: bData,
      synced_at: new Date().toISOString()
    };
    
    const { error } = await supabase
      .from('sync_shadow')
      .upsert({
        email: normalizeEmail(email),
        snapshot
      }, {
        onConflict: 'email'
      });

    if (error) {
      console.error('Failed to update shadow state:', error);
      throw error;
    }
  } catch (error) {
    console.error('Failed to update shadow state:', error);
    throw error;
  }
}

/**
 * Process sync for a single record with database-backed shadow state
 */
export async function syncRecord(
  email: string,
  aData: Record<string, any>,
  bData: Record<string, any>
): Promise<{
  updates: { field: string; direction: 'A→B' | 'B→A'; value: any }[];
  conflicts: FieldConflict[];
  logs: Array<{ field: string; action: string; direction?: string; result: string }>;
}> {
  // Get shadow state from database
  const shadowState = await getShadowState(email);
  const shadowA = shadowState?.aData || {};
  const shadowB = shadowState?.bData || {};
  
  const updates: { field: string; direction: 'A→B' | 'B→A'; value: any }[] = [];
  const conflicts: FieldConflict[] = [];
  const logs: Array<{ field: string; action: string; direction?: string; result: string }> = [];

  // Process each field in CLIENT_FIELD_MAPPINGS
  for (const [aField, bField] of Object.entries(CLIENT_FIELD_MAPPINGS)) {
    const decision = decideSyncAction(
      aField,
      aData[aField],
      bData[bField],
      shadowA[aField],
      shadowB[bField]
    );

    switch (decision.action) {
      case 'update_a':
        updates.push({
          field: aField,
          direction: 'B→A',
          value: bData[bField]
        });
        logs.push({
          field: aField,
          action: 'update',
          direction: 'B→A',
          result: 'applied'
        });
        break;

      case 'update_b':
        updates.push({
          field: bField,
          direction: 'A→B', 
          value: aData[aField]
        });
        logs.push({
          field: aField,
          action: 'update',
          direction: 'A→B',
          result: 'applied'
        });
        break;

      case 'conflict':
        if (decision.conflict) {
          conflicts.push(decision.conflict);
        }
        logs.push({
          field: aField,
          action: 'conflict',
          result: 'conflict'
        });
        break;

      case 'skip':
        logs.push({
          field: aField,
          action: 'skip',
          result: 'skipped'
        });
        break;
    }
  }

  return { updates, conflicts, logs };
}

/**
 * Log sync activities to database
 */
export async function logSyncActivity(
  email: string,
  logs: Array<{ field: string; action: string; direction?: string; result: string }>
): Promise<void> {
  try {
    const logEntries = logs.map(log => ({
      email: normalizeEmail(email),
      direction: (log.direction as 'A→B' | 'B→A' | 'bidirectional') || 'bidirectional',
      action: log.action,
      result: log.result,
      field: log.field,
      dedupe_key: `${email}_${log.field}_${log.action}_${Date.now()}`
    }));

    if (logEntries.length > 0) {
      const { error } = await supabase
        .from('sync_log')
        .insert(logEntries);

      if (error) {
        console.error('Failed to log sync activities:', error);
        throw error;
      }
    }
  } catch (error) {
    console.error('Failed to log sync activities:', error);
    throw error;
  }
}

/**
 * Store conflicts in database
 */
export async function storeConflicts(
  email: string,
  conflicts: FieldConflict[]
): Promise<void> {
  try {
    const conflictEntries = conflicts.map(conflict => ({
      email: normalizeEmail(email),
      field: conflict.field,
      a_value: String(conflict.a_value || ''),
      b_value: String(conflict.b_value || ''),
      status: 'pending' as const
    }));

    if (conflictEntries.length > 0) {
      const { error } = await supabase
        .from('sync_conflicts')
        .insert(conflictEntries);

      if (error) {
        console.error('Failed to store conflicts:', error);
        throw error;
      }
    }
  } catch (error) {
    console.error('Failed to store conflicts:', error);
    throw error;
  }
}

/**
 * Update crosswalk mapping in database
 */
export async function updateCrosswalk(
  email: string,
  aId: string,
  bId?: string
): Promise<void> {
  try {
    const { error } = await supabase
      .from('integration_crosswalk')
      .upsert({
        email: normalizeEmail(email),
        a_id: aId,
        b_id: bId
      }, {
        onConflict: 'email'
      });

    if (error) {
      console.error('Failed to update crosswalk:', error);
      throw error;
    }
  } catch (error) {
    console.error('Failed to update crosswalk:', error);
    throw error;
  }
}

/**
 * Get crosswalk mapping from database
 */
export async function getCrosswalk(email: string): Promise<{
  a_id: string;
  b_id?: string;
} | null> {
  try {
    const { data, error } = await supabase
      .from('integration_crosswalk')
      .select('a_id, b_id')
      .eq('email', normalizeEmail(email))
      .maybeSingle();

    if (error) {
      console.error('Failed to get crosswalk:', error);
      return null;
    }

    return data ? {
      a_id: data.a_id,
      b_id: data.b_id
    } : null;
  } catch (error) {
    console.error('Failed to get crosswalk:', error);
    return null;
  }
}

/**
 * Main sync orchestrator function - fully database-backed
 */
export async function orchestrateSync(
  email: string,
  clientData: Record<string, any>,
  mailerLiteData: Record<string, any>
): Promise<{
  success: boolean;
  conflicts: FieldConflict[];
  appliedUpdates: number;
  message: string;
}> {
  try {
    console.log(`Starting orchestrated sync for ${email}`);
    
    // Process the sync with database-backed shadow state
    const { updates, conflicts, logs } = await syncRecord(email, clientData, mailerLiteData);
    
    // Log sync activities to database
    if (logs.length > 0) {
      await logSyncActivity(email, logs);
    }
    
    // Store conflicts in database
    if (conflicts.length > 0) {
      await storeConflicts(email, conflicts);
    }
    
    // Update shadow state in database
    await updateShadowState(email, clientData, mailerLiteData);
    
    // Update crosswalk in database
    const clientId = clientData.id || clientData.email;
    const mailerLiteId = mailerLiteData.id;
    if (clientId) {
      await updateCrosswalk(email, clientId, mailerLiteId);
    }
    
    const message = conflicts.length > 0 
      ? `Sync completed with ${conflicts.length} conflicts requiring resolution`
      : `Sync completed successfully with ${updates.length} updates applied`;
    
    return {
      success: true,
      conflicts,
      appliedUpdates: updates.length,
      message
    };
    
  } catch (error) {
    console.error('Sync orchestration failed:', error);
    return {
      success: false,
      conflicts: [],
      appliedUpdates: 0,
      message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}