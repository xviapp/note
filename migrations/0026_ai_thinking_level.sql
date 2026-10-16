ALTER TABLE ai_settings ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'none'
  CHECK(thinking_level IN ('none','low','high','max'));
