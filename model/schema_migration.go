package model

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SchemaMigrationModel records successful historical repairs. Keys are persistent
// protocol identifiers and must not be renamed once released.
type SchemaMigrationModel struct {
	Key         string    `gorm:"primaryKey;size:160"`
	CompletedAt time.Time `gorm:"not null"`
}

func (*SchemaMigrationModel) TableName() string { return "schema_migrations" }

func EnsureSchemaMigrationTable(conn *gorm.DB) error {
	return conn.AutoMigrate(&SchemaMigrationModel{})
}

func SchemaMigrationCompleted(conn *gorm.DB, key string) (bool, error) {
	var count int64
	err := conn.Model(&SchemaMigrationModel{}).Where(map[string]any{"key": key}).Count(&count).Error
	return count > 0, err
}

func MarkSchemaMigrationCompleted(conn *gorm.DB, key string) error {
	return conn.Clauses(clause.OnConflict{DoNothing: true}).Create(&SchemaMigrationModel{
		Key: key, CompletedAt: time.Now(),
	}).Error
}

// RunSchemaMigration leaves transaction boundaries to the repair itself. A failed
// repair or marker write remains eligible for retry on the next startup.
func RunSchemaMigration(conn *gorm.DB, key string, fn func() error) error {
	completed, err := SchemaMigrationCompleted(conn, key)
	if err != nil || completed {
		return err
	}
	if err := fn(); err != nil {
		return err
	}
	return MarkSchemaMigrationCompleted(conn, key)
}
