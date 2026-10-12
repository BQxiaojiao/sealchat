package service

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"os"
	"testing"

	"sealchat/utils"
)

func writeTheaterMediaFixture(t *testing.T, data []byte) string {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "media-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return file.Name()
}

func TestTheaterMediaProbeStaticPNG(t *testing.T) {
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatal(err)
	}
	path := writeTheaterMediaFixture(t, buffer.Bytes())
	metadata, err := probeTheaterMedia(context.Background(), path, "static_image", "image/png", normalizeTheaterMediaConfig(utils.TheaterMediaConfig{}), MediaToolchain{}, execMediaCommandRunner{})
	if err != nil {
		t.Fatalf("probe PNG: %v", err)
	}
	if metadata.Width != 4 || metadata.Height != 3 || metadata.FrameCount != 1 {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestTheaterMediaProbeAnimatedGIF(t *testing.T) {
	palette := color.Palette{color.Black, color.White}
	animation := &gif.GIF{Image: []*image.Paletted{image.NewPaletted(image.Rect(0, 0, 2, 2), palette), image.NewPaletted(image.Rect(0, 0, 2, 2), palette)}, Delay: []int{2, 3}}
	var buffer bytes.Buffer
	if err := gif.EncodeAll(&buffer, animation); err != nil {
		t.Fatal(err)
	}
	path := writeTheaterMediaFixture(t, buffer.Bytes())
	metadata, err := probeTheaterMedia(context.Background(), path, "animated_image", "image/gif", normalizeTheaterMediaConfig(utils.TheaterMediaConfig{}), MediaToolchain{}, execMediaCommandRunner{})
	if err != nil {
		t.Fatalf("probe GIF: %v", err)
	}
	if metadata.FrameCount != 2 || metadata.DurationMS != 50 {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestTheaterMediaRejectsSVG(t *testing.T) {
	mimeType, kind := detectTheaterMediaType([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`))
	if mimeType != "" || kind != "" {
		t.Fatalf("SVG detected as %s/%s", mimeType, kind)
	}
}

func makeTestAPNG(t *testing.T, frames int, numerator, denominator uint16, plays uint32) []byte {
	t.Helper()
	var base bytes.Buffer
	if err := png.Encode(&base, image.NewNRGBA(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatal(err)
	}
	var header, pixels []byte
	for offset := 8; offset+12 <= base.Len(); {
		data := base.Bytes()
		size := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		switch string(data[offset+4 : offset+8]) {
		case "IHDR":
			header = data[offset+8 : offset+8+size]
		case "IDAT":
			pixels = append(pixels, data[offset+8:offset+8+size]...)
		}
		offset += size + 12
	}
	appendChunk := func(target []byte, name string, payload []byte) []byte {
		length := make([]byte, 4)
		binary.BigEndian.PutUint32(length, uint32(len(payload)))
		target = append(target, length...)
		start := len(target)
		target = append(target, name...)
		target = append(target, payload...)
		checksum := make([]byte, 4)
		binary.BigEndian.PutUint32(checksum, crc32.ChecksumIEEE(target[start:]))
		return append(target, checksum...)
	}
	data := appendChunk([]byte("\x89PNG\r\n\x1a\n"), "IHDR", header)
	animation := make([]byte, 8)
	binary.BigEndian.PutUint32(animation[:4], uint32(frames))
	binary.BigEndian.PutUint32(animation[4:], plays)
	data = appendChunk(data, "acTL", animation)
	sequence := uint32(0)
	for index := 0; index < frames; index++ {
		control := make([]byte, 26)
		binary.BigEndian.PutUint32(control[:4], sequence)
		sequence++
		binary.BigEndian.PutUint32(control[4:8], 4)
		binary.BigEndian.PutUint32(control[8:12], 3)
		binary.BigEndian.PutUint16(control[20:22], numerator)
		binary.BigEndian.PutUint16(control[22:24], denominator)
		data = appendChunk(data, "fcTL", control)
		if index == 0 {
			data = appendChunk(data, "IDAT", pixels)
		} else {
			frame := make([]byte, 4, 4+len(pixels))
			binary.BigEndian.PutUint32(frame, sequence)
			sequence++
			data = appendChunk(data, "fdAT", append(frame, pixels...))
		}
	}
	// Chunk-like strings in ancillary data must not be read as frame controls.
	data = appendChunk(data, "tEXt", []byte("comment\x00fcTLacTL"))
	return appendChunk(data, "IEND", nil)
}

func TestTheaterMediaProbeAPNGFrameDelay(t *testing.T) {
	for _, testCase := range []struct {
		name                   string
		frames                 int
		numerator, denominator uint16
		plays                  uint32
		duration               int64
	}{
		{"golden-record-timing", 150, 33, 1000, 0, 4950},
		{"fractional-frame-delay", 60, 1, 60, 2, 1000},
		{"default-denominator", 3, 1, 0, 1, 30},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			path := writeTheaterMediaFixture(t, makeTestAPNG(t, testCase.frames, testCase.numerator, testCase.denominator, testCase.plays))
			metadata, err := parseAPNGMetadata(path)
			if err != nil {
				t.Fatal(err)
			}
			if metadata.DurationMS != testCase.duration || metadata.FrameCount != testCase.frames || metadata.LoopCount == nil || *metadata.LoopCount != int(testCase.plays) {
				t.Fatalf("APNG frame timing = %#v", metadata)
			}
		})
	}
}

func TestTheaterMediaProbeAPNGRejectsInvalidChunkSize(t *testing.T) {
	data := makeTestAPNG(t, 2, 1, 2, 0)
	binary.BigEndian.PutUint32(data[8:12], ^uint32(0))
	if _, err := parseAPNGMetadata(writeTheaterMediaFixture(t, data)); err == nil {
		t.Fatal("invalid APNG chunk accepted")
	}
}
