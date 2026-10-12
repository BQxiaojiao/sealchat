package model

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"sealchat/utils"
)

func openSchemaMigrationTestDB(t *testing.T, dsn string) *gorm.DB {
	t.Helper()
	conn, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open migration test database: %v", err)
	}
	sqlDB, err := conn.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := EnsureSchemaMigrationTable(conn); err != nil {
		t.Fatalf("ensure migration ledger: %v", err)
	}
	return conn
}

func newSchemaMigrationTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	return openSchemaMigrationTestDB(t, fmt.Sprintf("file:schema-migration-%s?mode=memory&cache=shared", utils.NewID()))
}

func requireSchemaMigrationCompleted(t *testing.T, conn *gorm.DB, key string, want bool) {
	t.Helper()
	completed, err := SchemaMigrationCompleted(conn, key)
	if err != nil {
		t.Fatalf("check migration %s: %v", key, err)
	}
	if completed != want {
		t.Fatalf("migration %s completed = %v, want %v", key, completed, want)
	}
}

func TestSchemaMigrationRunsOnceAndPersists(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "ledger.db")
	conn := openSchemaMigrationTestDB(t, dsn)
	calls := 0
	repair := func() error { calls++; return nil }
	for range 2 {
		if err := RunSchemaMigration(conn, "first_v1", repair); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("repair calls = %d, want 1", calls)
	}
	var marker SchemaMigrationModel
	if err := conn.Where(map[string]any{"key": "first_v1"}).Take(&marker).Error; err != nil {
		t.Fatalf("read persisted marker: %v", err)
	}
	if marker.CompletedAt.IsZero() {
		t.Fatal("missing completion timestamp")
	}
	if err := RunSchemaMigration(conn, "second_v1", repair); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("independent key did not execute: calls = %d", calls)
	}
	sqlDB, err := conn.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	conn = openSchemaMigrationTestDB(t, dsn)
	for _, key := range []string{"first_v1", "second_v1"} {
		requireSchemaMigrationCompleted(t, conn, key, true)
		if err := RunSchemaMigration(conn, key, repair); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatalf("repair repeated after reopening database: calls = %d", calls)
	}
}

func TestSchemaMigrationFailureRetries(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	repairErr := errors.New("repair failed")
	calls := 0
	repair := func() error {
		calls++
		if calls == 1 {
			return repairErr
		}
		return nil
	}
	if err := RunSchemaMigration(conn, "retry_v1", repair); !errors.Is(err, repairErr) {
		t.Fatalf("repair error = %v, want %v", err, repairErr)
	}
	requireSchemaMigrationCompleted(t, conn, "retry_v1", false)
	for range 2 {
		if err := RunSchemaMigration(conn, "retry_v1", repair); err != nil {
			t.Fatal(err)
		}
	}
	requireSchemaMigrationCompleted(t, conn, "retry_v1", true)
	if calls != 2 {
		t.Fatalf("repair calls = %d, want failed attempt plus one retry", calls)
	}
}

func TestSchemaMigrationMarkerFailureRetries(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	markerErr := errors.New("marker write failed")
	failMarker := true
	if err := conn.Callback().Create().Before("gorm:create").Register("test:fail_migration_marker", func(tx *gorm.DB) {
		if failMarker && tx.Statement.Table == "schema_migrations" {
			tx.AddError(markerErr)
		}
	}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	repair := func() error { calls++; return nil }
	if err := RunSchemaMigration(conn, "marker_retry_v1", repair); !errors.Is(err, markerErr) {
		t.Fatalf("marker error = %v, want %v", err, markerErr)
	}
	requireSchemaMigrationCompleted(t, conn, "marker_retry_v1", false)
	failMarker = false
	if err := RunSchemaMigration(conn, "marker_retry_v1", repair); err != nil {
		t.Fatal(err)
	}
	requireSchemaMigrationCompleted(t, conn, "marker_retry_v1", true)
	if calls != 2 {
		t.Fatalf("repair calls = %d, want 2", calls)
	}
}

func TestSchemaMigrationUnavailableLedgerDoesNotRunRepair(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.Migrator().DropTable(&SchemaMigrationModel{}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if err := RunSchemaMigration(conn, "unavailable_v1", func() error { calls++; return nil }); err == nil {
		t.Fatal("missing ledger did not return an error")
	}
	if calls != 0 {
		t.Fatal("repair executed without the ledger")
	}
}

// Observe calls while still using the real SQLite migrator and its DDL behavior.
type quoteMigrationTestDialector struct {
	gorm.Dialector
	tableChecks int
	dropCalls   int
	dropErr     error
}

func (d *quoteMigrationTestDialector) Migrator(conn *gorm.DB) gorm.Migrator {
	return &quoteMigrationTestMigrator{Migrator: d.Dialector.Migrator(conn), observer: d}
}

type quoteMigrationTestMigrator struct {
	gorm.Migrator
	observer *quoteMigrationTestDialector
}

func (m *quoteMigrationTestMigrator) HasTable(value any) bool {
	m.observer.tableChecks++
	return m.Migrator.HasTable(value)
}

func (m *quoteMigrationTestMigrator) DropConstraint(value any, name string) error {
	m.observer.dropCalls++
	if m.observer.dropErr != nil {
		return m.observer.dropErr
	}
	return m.Migrator.DropConstraint(value, name)
}

func sqliteSchemaVersion(t *testing.T, conn *gorm.DB) int {
	t.Helper()
	var version int
	if err := conn.Raw("PRAGMA schema_version").Row().Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}

func TestMessageAutoMigrateIsIdempotentOnSQLite(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.AutoMigrate(&MessageModel{}); err != nil {
		t.Fatalf("initial message migrate: %v", err)
	}
	before := sqliteSchemaVersion(t, conn)
	if err := conn.AutoMigrate(&MessageModel{}); err != nil {
		t.Fatalf("second message migrate: %v", err)
	}
	if after := sqliteSchemaVersion(t, conn); after != before {
		t.Fatalf("second message AutoMigrate changed schema_version: %d -> %d", before, after)
	}
}

func TestMessagesDropQuoteConstraintSQLite(t *testing.T) {
	for _, scenario := range []string{"missing table", "no constraint", "legacy constraint"} {
		t.Run(scenario, func(t *testing.T) {
			conn := newSchemaMigrationTestDB(t)
			legacy := scenario == "legacy constraint"
			if scenario != "missing table" {
				ddl := "CREATE TABLE messages (id text PRIMARY KEY, quote_id text, content text)"
				if legacy {
					ddl = `CREATE TABLE messages (id text PRIMARY KEY, quote_id text, content text, CONSTRAINT "fk_messages_quote" FOREIGN KEY (quote_id) REFERENCES messages(id))`
				}
				if err := conn.Exec(ddl).Error; err != nil {
					t.Fatal(err)
				}
				if err := conn.Exec("INSERT INTO messages (id, content) VALUES (?, ?)", "legacy-message", "preserved").Error; err != nil {
					t.Fatal(err)
				}
			}
			if got := conn.Migrator().HasConstraint(&MessageModel{}, "fk_messages_quote"); got != legacy {
				t.Fatalf("initial constraint = %v, want %v", got, legacy)
			}
			observer := &quoteMigrationTestDialector{Dialector: conn.Dialector}
			conn.Config.Dialector = observer
			before := sqliteSchemaVersion(t, conn)
			if err := migrateMessageQuoteConstraint(conn); err != nil {
				t.Fatal(err)
			}
			after := sqliteSchemaVersion(t, conn)
			wantDrops := 0
			if legacy {
				wantDrops = 1
				if after <= before {
					t.Fatal("legacy constraint removal did not change the schema")
				}
			} else if after != before {
				t.Fatalf("no constraint: schema_version changed from %d to %d", before, after)
			}
			if observer.dropCalls != wantDrops {
				t.Fatalf("DropConstraint calls = %d, want %d", observer.dropCalls, wantDrops)
			}
			if conn.Migrator().HasConstraint(&MessageModel{}, "fk_messages_quote") {
				t.Fatal("quote constraint still present")
			}
			requireSchemaMigrationCompleted(t, conn, "messages_drop_quote_fk_v1", true)
			checks := observer.tableChecks
			if err := migrateMessageQuoteConstraint(conn); err != nil {
				t.Fatal(err)
			}
			if observer.tableChecks != checks || observer.dropCalls != wantDrops {
				t.Fatal("completed migration still checked or changed messages")
			}
			if got := sqliteSchemaVersion(t, conn); got != after {
				t.Fatalf("second migration changed schema_version to %d, want %d", got, after)
			}
			if scenario != "missing table" {
				var content string
				if err := conn.Table("messages").Select("content").Where("id = ?", "legacy-message").Scan(&content).Error; err != nil {
					t.Fatal(err)
				}
				if content != "preserved" {
					t.Fatalf("message content = %q, want preserved", content)
				}
			}
		})
	}
}

func TestMessagesDropQuoteConstraintFailureRetries(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.Exec(`CREATE TABLE messages (id text PRIMARY KEY, quote_id text, CONSTRAINT "fk_messages_quote" FOREIGN KEY (quote_id) REFERENCES messages(id))`).Error; err != nil {
		t.Fatal(err)
	}
	dropErr := errors.New("drop constraint failed")
	observer := &quoteMigrationTestDialector{Dialector: conn.Dialector, dropErr: dropErr}
	conn.Config.Dialector = observer
	if err := migrateMessageQuoteConstraint(conn); !errors.Is(err, dropErr) {
		t.Fatalf("drop error = %v, want %v", err, dropErr)
	}
	requireSchemaMigrationCompleted(t, conn, "messages_drop_quote_fk_v1", false)
	observer.dropErr = nil
	if err := migrateMessageQuoteConstraint(conn); err != nil {
		t.Fatal(err)
	}
	requireSchemaMigrationCompleted(t, conn, "messages_drop_quote_fk_v1", true)
	if observer.dropCalls != 2 {
		t.Fatalf("DropConstraint calls = %d, want 2 attempts", observer.dropCalls)
	}
}

func TestAudioSortOrderBackfillLedgerSkipsHistoricalScan(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.AutoMigrate(&AudioAsset{}); err != nil {
		t.Fatal(err)
	}
	previousDB := db
	db = conn
	t.Cleanup(func() { db = previousDB })
	asset := AudioAsset{StringPKBaseModel: StringPKBaseModel{ID: "legacy-audio"}}
	if err := conn.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	scans := 0
	if err := conn.Callback().Query().Before("gorm:query").Register("test:count_audio_scans", func(tx *gorm.DB) {
		if tx.Statement.Table == "audio_assets" {
			scans++
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := RunSchemaMigration(conn, "audio_asset_sort_order_backfill_v1", BackfillAudioAssetSortOrder); err != nil {
		t.Fatal(err)
	}
	if scans != 1 {
		t.Fatalf("initial audio scans = %d, want 1", scans)
	}
	var order int
	if err := conn.Table("audio_assets").Select("sort_order").Where("id = ?", asset.ID).Scan(&order).Error; err != nil {
		t.Fatal(err)
	}
	if order != 1000 {
		t.Fatalf("backfilled sort_order = %d, want 1000", order)
	}
	if err := conn.Model(&AudioAsset{}).Where("id = ?", asset.ID).Update("sort_order", 0).Error; err != nil {
		t.Fatal(err)
	}
	if err := RunSchemaMigration(conn, "audio_asset_sort_order_backfill_v1", BackfillAudioAssetSortOrder); err != nil {
		t.Fatal(err)
	}
	if scans != 1 {
		t.Fatalf("completed backfill scanned audio again: scans = %d", scans)
	}
	requireSchemaMigrationCompleted(t, conn, "audio_asset_sort_order_backfill_v1", true)
}

func TestWorldBackfillMissingTableDoesNotMarkCompleted(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	previousDB := db
	db = conn
	t.Cleanup(func() { db = previousDB })

	if err := RunSchemaMigration(conn, "world_data_backfill_v1", BackfillWorldData); err == nil {
		t.Fatal("missing worlds table unexpectedly completed world backfill")
	}
	requireSchemaMigrationCompleted(t, conn, "world_data_backfill_v1", false)

	if err := conn.AutoMigrate(&WorldModel{}, &ChannelModel{}); err != nil {
		t.Fatal(err)
	}
	if err := RunSchemaMigration(conn, "world_data_backfill_v1", BackfillWorldData); err != nil {
		t.Fatalf("retry world backfill after schema recovery: %v", err)
	}
	requireSchemaMigrationCompleted(t, conn, "world_data_backfill_v1", true)
}

func TestWorldBackfillWriteFailureDoesNotMarkCompleted(t *testing.T) {
	conn := newSchemaMigrationTestDB(t)
	if err := conn.AutoMigrate(&WorldModel{}, &ChannelModel{}); err != nil {
		t.Fatal(err)
	}
	previousDB := db
	db = conn
	t.Cleanup(func() { db = previousDB })
	channel := ChannelModel{StringPKBaseModel: StringPKBaseModel{ID: "legacy-channel"}}
	if err := conn.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	if err := conn.Model(&channel).Update("status", "").Error; err != nil {
		t.Fatal(err)
	}
	repairErr := errors.New("channel status backfill failed")
	failRepair := true
	if err := conn.Callback().Update().Before("gorm:update").Register("test:fail_world_backfill", func(tx *gorm.DB) {
		updates, _ := tx.Statement.Dest.(map[string]any)
		if _, updatingStatus := updates["status"]; failRepair && updatingStatus && tx.Statement.Table == "channels" {
			tx.AddError(repairErr)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := RunSchemaMigration(conn, "world_data_backfill_v1", BackfillWorldData); !errors.Is(err, repairErr) {
		t.Fatalf("world backfill error = %v, want %v", err, repairErr)
	}
	requireSchemaMigrationCompleted(t, conn, "world_data_backfill_v1", false)
	failRepair = false
	if err := RunSchemaMigration(conn, "world_data_backfill_v1", BackfillWorldData); err != nil {
		t.Fatal(err)
	}
	requireSchemaMigrationCompleted(t, conn, "world_data_backfill_v1", true)
	if err := conn.First(&channel, "id = ?", channel.ID).Error; err != nil {
		t.Fatal(err)
	}
	if channel.WorldID == "" || channel.Status != ChannelStatusActive {
		t.Fatalf("world backfill left channel world_id=%q status=%q", channel.WorldID, channel.Status)
	}
	var world WorldModel
	if err := conn.First(&world, "id = ?", channel.WorldID).Error; err != nil {
		t.Fatal(err)
	}
	if !world.IsSystemDefault || world.DefaultChannelID != channel.ID {
		t.Fatalf("world backfill left default world=%v default_channel_id=%q", world.IsSystemDefault, world.DefaultChannelID)
	}
}
