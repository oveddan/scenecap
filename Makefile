.PHONY: build test check

build:
	go build -o scenecap ./cmd/scenecap

test:
	go test ./...

check:
	gofmt -w cmd internal
	go vet ./...
	go test ./...

