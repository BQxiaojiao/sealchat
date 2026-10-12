package model

import (
	"errors"
	"testing"

	"gorm.io/gorm"
)

func TestMigrateTTSInitializesLedgerForStandaloneCallers(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.Migrator().DropTable(&SchemaMigrationModel{}); err != nil {
		t.Fatal(err)
	}
	if err := MigrateTTS(conn); err != nil {
		t.Fatalf("standalone TTS migration: %v", err)
	}
	requireSchemaMigrationCompleted(t, conn, "tts_legacy_nullable_defaults_v1", true)
}

func TestMigrateTTSLedgerInitializationFailureStopsRepair(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.Migrator().DropTable(&SchemaMigrationModel{}); err != nil {
		t.Fatal(err)
	}
	if err := conn.Exec("CREATE VIEW schema_migrations AS SELECT 'existing' AS key").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateTTS(conn); err == nil {
		t.Fatal("ledger initialization failure did not stop TTS migration")
	}
	if conn.Migrator().HasTable(&TTSVoice{}) {
		t.Fatal("TTS schema migration ran after ledger initialization failed")
	}
}

func TestMigrateTTSRepairsNullableDefaultsOnceAndStillMigratesSchema(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.Exec("CREATE TABLE channel_identity_tts_configs (id text PRIMARY KEY, disabled numeric)").Error; err != nil {
		t.Fatal(err)
	}
	if err := conn.Exec("INSERT INTO channel_identity_tts_configs (id, disabled) VALUES (?, NULL)", "legacy-tts").Error; err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"ai_usage_logs", "ai_usage_ledgers", "ai_quota_reservations"} {
		if err := conn.Exec("CREATE TABLE " + table + " (id text PRIMARY KEY, updated_at datetime, quota_kind text DEFAULT 'text')").Error; err != nil {
			t.Fatal(err)
		}
		if err := conn.Exec("INSERT INTO "+table+" (id, quota_kind) VALUES (?, NULL), (?, '')", "legacy-null", "legacy-empty").Error; err != nil {
			t.Fatal(err)
		}
	}
	repairs := 0
	if err := conn.Callback().Update().Before("gorm:update").Register("test:count_tts_repairs", func(tx *gorm.DB) {
		repairs++
	}); err != nil {
		t.Fatal(err)
	}
	if err := MigrateTTS(conn); err != nil {
		t.Fatalf("migrate nullable legacy TTS tables: %v", err)
	}
	var disabled *bool
	if err := conn.Table("channel_identity_tts_configs").Select("disabled").Where("id = ?", "legacy-tts").Row().Scan(&disabled); err != nil {
		t.Fatal(err)
	}
	if disabled == nil || *disabled {
		t.Fatalf("repaired disabled = %v, want non-NULL false", disabled)
	}
	var columns []struct {
		Name    string
		NotNull int `gorm:"column:notnull"`
	}
	if err := conn.Raw("PRAGMA table_info(channel_identity_tts_configs)").Scan(&columns).Error; err != nil {
		t.Fatal(err)
	}
	foundDisabled := false
	for _, column := range columns {
		if column.Name == "disabled" {
			foundDisabled = true
			if column.NotNull != 1 {
				var ddl string
				conn.Raw("SELECT sql FROM sqlite_master WHERE name = 'channel_identity_tts_configs'").Scan(&ddl)
				t.Fatalf("disabled column did not migrate to NOT NULL: %s", ddl)
			}
		}
	}
	if !foundDisabled {
		t.Fatal("missing disabled column")
	}
	for _, table := range []string{"ai_usage_logs", "ai_usage_ledgers", "ai_quota_reservations"} {
		var repaired int64
		if err := conn.Table(table).Where("quota_kind = ?", QuotaKindText).Count(&repaired).Error; err != nil {
			t.Fatal(err)
		}
		if repaired != 2 {
			t.Fatalf("%s repaired quota kinds = %d, want 2", table, repaired)
		}
	}
	if repairs != 7 {
		t.Fatalf("legacy repair statements = %d, want 7 pre/post repairs", repairs)
	}
	requireSchemaMigrationCompleted(t, conn, "tts_legacy_nullable_defaults_v1", true)
	// Simulate a field absent from an older schema after the repair has completed.
	if err := conn.Migrator().DropColumn(&ChannelIdentityTTSConfig{}, "speech_language"); err != nil {
		t.Fatal(err)
	}
	if err := MigrateTTS(conn); err != nil {
		t.Fatalf("second TTS schema migration: %v", err)
	}
	if !conn.Migrator().HasColumn(&ChannelIdentityTTSConfig{}, "speech_language") {
		t.Fatal("completed legacy migration prevented TTS AutoMigrate")
	}
	if repairs != 7 {
		t.Fatalf("completed TTS migration repeated legacy repairs: statements = %d", repairs)
	}
}

func TestMigrateTTSRepairFailuresDoNotMarkCompleted(t *testing.T) {
	for _, phase := range []string{"pre-schema", "post-schema"} {
		t.Run(phase, func(t *testing.T) {
			conn := newSchemaMigrationTestDB(t)
			if phase == "pre-schema" {
				if err := conn.Exec("CREATE TABLE channel_identity_tts_configs (id text PRIMARY KEY, disabled numeric)").Error; err != nil {
					t.Fatal(err)
				}
				if err := conn.Exec("INSERT INTO channel_identity_tts_configs (id, disabled) VALUES (?, NULL)", "legacy-tts").Error; err != nil {
					t.Fatal(err)
				}
			}
			repairErr := errors.New("legacy TTS repair failed")
			failRepair := true
			if err := conn.Callback().Update().Before("gorm:update").Register("test:fail_tts_repair", func(tx *gorm.DB) {
				if failRepair {
					tx.AddError(repairErr)
				}
			}); err != nil {
				t.Fatal(err)
			}
			if err := MigrateTTS(conn); !errors.Is(err, repairErr) {
				t.Fatalf("repair error = %v, want %v", err, repairErr)
			}
			requireSchemaMigrationCompleted(t, conn, "tts_legacy_nullable_defaults_v1", false)
			failRepair = false
			if err := MigrateTTS(conn); err != nil {
				t.Fatalf("retry TTS migration: %v", err)
			}
			requireSchemaMigrationCompleted(t, conn, "tts_legacy_nullable_defaults_v1", true)
		})
	}
}
