-- Add data quality tracking columns to sync_shadow table
ALTER TABLE sync_shadow 
ADD COLUMN IF NOT EXISTS validation_status text DEFAULT 'complete' CHECK (validation_status IN ('complete', 'incomplete', 'error')),
ADD COLUMN IF NOT EXISTS data_quality jsonb DEFAULT '{}',
ADD COLUMN IF NOT EXISTS last_validated_at timestamptz DEFAULT now();

-- Create index for faster quality queries
CREATE INDEX IF NOT EXISTS idx_sync_shadow_validation_status ON sync_shadow(validation_status);

-- Add comment explaining the columns
COMMENT ON COLUMN sync_shadow.validation_status IS 'Tracks if shadow has complete data from both sources: complete, incomplete, error';
COMMENT ON COLUMN sync_shadow.data_quality IS 'JSON object tracking missing fields, data completeness, validation errors';
COMMENT ON COLUMN sync_shadow.last_validated_at IS 'Timestamp of last data quality validation';