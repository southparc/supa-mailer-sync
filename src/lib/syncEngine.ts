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

  // Both changed, different values - check empty/fill rule
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
 * Process sync for a single record
 * Note: Currently using localStorage for shadow state until new DB schema is deployed
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
  // Get shadow state from localStorage for now
  const shadowKey = `sync_shadow_${email}`;
  const shadowData = localStorage.getItem(shadowKey);
  const shadow = shadowData ? JSON.parse(shadowData) : { a: {}, b: {} };
  
  const updates: { field: string; direction: 'A→B' | 'B→A'; value: any }[] = [];
  const conflicts: FieldConflict[] = [];
  const logs: Array<{ field: string; action: string; direction?: string; result: string }> = [];

  // Process each field in CLIENT_FIELD_MAPPINGS
  for (const [aField, bField] of Object.entries(CLIENT_FIELD_MAPPINGS)) {
    const decision = decideSyncAction(
      aField,
      aData[aField],
      bData[bField],
      shadow.a[aField],
      shadow.b[bField]
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
 * Update shadow state after sync
 * Note: Currently using localStorage until new DB schema is deployed
 */
export async function updateShadowState(
  email: string,
  aData: Record<string, any>,
  bData: Record<string, any>
): Promise<void> {
  const shadowKey = `sync_shadow_${email}`;
  const snapshot = {
    a: aData,
    b: bData,
    synced_at: new Date().toISOString()
  };

  localStorage.setItem(shadowKey, JSON.stringify(snapshot));
}

/**
 * Log sync activities using ml_outbox table for now
 */
export async function logSyncActivity(
  email: string,
  logs: Array<{ field: string; action: string; direction?: string; result: string }>
): Promise<void> {
  // Use existing ml_outbox table to log sync activities for now
  const logEntries = logs.map(log => ({
    action: 'sync_log',
    entity_type: 'sync_activity',
    payload: {
      email,
      field: log.field,
      action: log.action,
      direction: log.direction || 'none',
      result: log.result,
      timestamp: new Date().toISOString()
    },
    status: 'completed' as const
  }));

  if (logEntries.length > 0) {
    await supabase
      .from('ml_outbox')
      .insert(logEntries);
  }
}

/**
 * Store conflicts using ml_outbox table for now
 */
export async function storeConflicts(
  email: string,
  conflicts: FieldConflict[]
): Promise<void> {
  const conflictEntries = conflicts.map(conflict => ({
    action: 'conflict_detected',
    entity_type: 'sync_conflict',
    payload: {
      email,
      field: conflict.field,
      a_value: conflict.a_value,
      b_value: conflict.b_value,
      a_updated_at: conflict.a_updated_at,
      b_updated_at: conflict.b_updated_at,
      detected_at: new Date().toISOString(),
      status: 'open'
    },
    status: 'pending' as const
  }));

  if (conflictEntries.length > 0) {
    await supabase
      .from('ml_outbox')
      .insert(conflictEntries);
  }
}

/**
 * Update crosswalk mapping - store in localStorage for now
 */
export async function updateCrosswalk(
  email: string,
  aId: string,
  bId?: string
): Promise<void> {
  const crosswalkKey = 'integration_crosswalk';
  const existingData = localStorage.getItem(crosswalkKey);
  const crosswalk = existingData ? JSON.parse(existingData) : {};
  
  crosswalk[email] = {
    a_id: aId,
    b_id: bId,
    updated_at: new Date().toISOString()
  };
  
  localStorage.setItem(crosswalkKey, JSON.stringify(crosswalk));
}

/**
 * Get crosswalk mapping
 */
export async function getCrosswalk(email: string): Promise<{
  a_id: string;
  b_id?: string;
} | null> {
  const crosswalkKey = 'integration_crosswalk';
  const existingData = localStorage.getItem(crosswalkKey);
  
  if (!existingData) return null;
  
  const crosswalk = JSON.parse(existingData);
  return crosswalk[email] || null;
}

/**
 * Main sync orchestrator function
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
    // Process the sync
    const { updates, conflicts, logs } = await syncRecord(email, clientData, mailerLiteData);
    
    // Apply updates (this would be done by the calling code)
    // Log the sync activity
    await logSyncActivity(email, logs);
    
    // Store any conflicts
    if (conflicts.length > 0) {
      await storeConflicts(email, conflicts);
    }
    
    // Update shadow state
    await updateShadowState(email, clientData, mailerLiteData);
    
    // Update crosswalk
    await updateCrosswalk(email, clientData.id, mailerLiteData.id);
    
    return {
      success: true,
      conflicts,
      appliedUpdates: updates.length,
      message: `Processed ${updates.length} updates, ${conflicts.length} conflicts detected`
    };
    
  } catch (error) {
    console.error('Sync orchestration failed:', error);
    return {
      success: false,
      conflicts: [],
      appliedUpdates: 0,
      message: `Sync failed: ${error}`
    };
  }
}