package model

import (
	"fmt"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"sealchat/utils"
)

func newTheaterModelTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	conn, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:theater-model-%s?mode=memory&cache=shared", utils.NewID())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open theater test database: %v", err)
	}
	if err := autoMigrateTheaterModels(conn); err != nil {
		t.Fatalf("migrate theater models: %v", err)
	}
	return conn
}

func TestTheaterAutoMigrateCreatesAllTables(t *testing.T) {
	conn := newTheaterModelTestDB(t)
	models := []any{
		&TheaterRoomModel{},
		&TheaterSnapshotModel{},
		&TheaterSceneModel{},
		&TheaterObjectModel{},
		&TheaterResourceModel{},
		&TheaterResourceVariantModel{},
		&TheaterResourceJobModel{},
		&TheaterMutationModel{},
		&TheaterAuditLogModel{},
	}
	for _, item := range models {
		if !conn.Migrator().HasTable(item) {
			t.Fatalf("missing table for %T", item)
		}
	}
	if !conn.Migrator().HasColumn(&TheaterObjectModel{}, "editable") {
		t.Fatal("theater_objects missing editable column")
	}
	if !conn.Migrator().HasColumn(&TheaterObjectModel{}, "scale") {
		t.Fatal("theater_objects missing scale column")
	}
	if !conn.Migrator().HasColumn(&TheaterObjectModel{}, "scale_x") || !conn.Migrator().HasColumn(&TheaterObjectModel{}, "scale_y") {
		t.Fatal("theater_objects missing scale axis columns")
	}
	if !conn.Migrator().HasColumn(&TheaterObjectModel{}, "aspect_ratio_locked") {
		t.Fatal("theater_objects missing aspect_ratio_locked column")
	}
	if !conn.Migrator().HasColumn(&TheaterPanelFolderModel{}, "preset_json") {
		t.Fatal("theater_panel_folders missing preset_json column")
	}
}

func TestTheaterUniqueIndexes(t *testing.T) {
	conn := newTheaterModelTestDB(t)

	room := TheaterRoomModel{WorldID: "world", ChannelID: "channel", SchemaVersion: 1, Status: "active"}
	if err := conn.Create(&room).Error; err != nil {
		t.Fatalf("create room: %v", err)
	}
	if err := conn.Create(&TheaterRoomModel{WorldID: room.WorldID, ChannelID: room.ChannelID, SchemaVersion: 1, Status: "active"}).Error; err == nil {
		t.Fatal("duplicate room scope unexpectedly accepted")
	}

	mutation := TheaterMutationModel{RoomID: room.ID, MutationID: "mutation", ActorUserID: "user", Type: "scene.create", Status: "applied"}
	if err := conn.Create(&mutation).Error; err != nil {
		t.Fatalf("create mutation: %v", err)
	}
	if err := conn.Create(&TheaterMutationModel{RoomID: room.ID, MutationID: mutation.MutationID, ActorUserID: "user", Type: "scene.create", Status: "applied"}).Error; err == nil {
		t.Fatal("duplicate mutation id unexpectedly accepted")
	}

	resource := TheaterResourceModel{RoomID: room.ID, AttachmentID: "attachment", Kind: "static_image", Status: "ready"}
	if err := conn.Create(&resource).Error; err != nil {
		t.Fatalf("create resource: %v", err)
	}
	variant := TheaterResourceVariantModel{ResourceID: resource.ID, Name: "original", AttachmentID: "attachment", Status: "ready"}
	if err := conn.Create(&variant).Error; err != nil {
		t.Fatalf("create variant: %v", err)
	}
	if err := conn.Create(&TheaterResourceVariantModel{ResourceID: resource.ID, Name: variant.Name, AttachmentID: "other", Status: "ready"}).Error; err == nil {
		t.Fatal("duplicate resource variant unexpectedly accepted")
	}

	job := TheaterResourceJobModel{ResourceID: resource.ID, RequestID: "request", Type: "probe", Status: "pending"}
	if err := conn.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := conn.Create(&TheaterResourceJobModel{ResourceID: resource.ID, RequestID: job.RequestID, Type: "probe", Status: "pending"}).Error; err == nil {
		t.Fatal("duplicate resource job unexpectedly accepted")
	}
}

func TestTheaterRevisionAndJSONRoundTrip(t *testing.T) {
	conn := newTheaterModelTestDB(t)
	revision := int64(1<<40 + 7)
	room := TheaterRoomModel{WorldID: "world-large", ChannelID: "channel-large", Revision: revision, SchemaVersion: 1, Status: "active"}
	if err := conn.Create(&room).Error; err != nil {
		t.Fatalf("create room: %v", err)
	}
	snapshotJSON := `{"activeSceneId":null,"payload":"` + string(make([]byte, 128*1024)) + `"}`
	snapshot := TheaterSnapshotModel{RoomID: room.ID, Revision: revision, SchemaVersion: 1, SnapshotJSON: snapshotJSON, SnapshotBytes: int64(len(snapshotJSON)), Kind: "automatic"}
	if err := conn.Create(&snapshot).Error; err != nil {
		t.Fatalf("create snapshot: %v", err)
	}

	var gotRoom TheaterRoomModel
	if err := conn.First(&gotRoom, "id = ?", room.ID).Error; err != nil {
		t.Fatalf("read room: %v", err)
	}
	if gotRoom.Revision != revision {
		t.Fatalf("revision = %d, want %d", gotRoom.Revision, revision)
	}
	var gotSnapshot TheaterSnapshotModel
	if err := conn.First(&gotSnapshot, "id = ?", snapshot.ID).Error; err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if gotSnapshot.SnapshotJSON != snapshotJSON {
		t.Fatalf("snapshot JSON length = %d, want %d", len(gotSnapshot.SnapshotJSON), len(snapshotJSON))
	}
}

func TestTheaterAutoMigrateIsIdempotent(t *testing.T) {
	conn := newTheaterModelTestDB(t)
	if err := autoMigrateTheaterModels(conn); err != nil {
		t.Fatalf("second migration: %v", err)
	}
}

func TestTheaterLegacyFieldsCopiesUniformScale(t *testing.T) {
	conn := newTheaterModelTestDB(t)
	object := TheaterObjectModel{
		StringPKBaseModel: StringPKBaseModel{ID: "legacy-scale"},
		RoomID:            "room", Kind: "group", Name: "Legacy", Width: 10, Height: 10,
		Scale: 0.6, ScaleX: 1, ScaleY: 1, OrderKey: "a",
		ContentJSON: `{}`, ActionsJSON: `[]`, MetadataJSON: `{}`, SchemaVersion: 1,
	}
	if err := conn.Create(&object).Error; err != nil {
		t.Fatalf("create legacy object: %v", err)
	}
	if err := migrateTheaterLegacyFields(conn); err != nil {
		t.Fatalf("migrate legacy scale: %v", err)
	}
	var got TheaterObjectModel
	if err := conn.First(&got, "id = ?", object.ID).Error; err != nil {
		t.Fatalf("read migrated object: %v", err)
	}
	if got.ScaleX != 0.6 || got.ScaleY != 0.6 {
		t.Fatalf("migrated scale = (%v, %v)", got.ScaleX, got.ScaleY)
	}
}
