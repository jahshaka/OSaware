#!/bin/bash
# Convert OSAWARE_BASIC_Manual.docx → OSAWARE_BASIC_Manual.pdf
# Usage: ./convert_manual.sh  (run from the docs/ folder)
#
# Requires LibreOffice (libreoffice or soffice in PATH).
# On macOS:  brew install --cask libreoffice
# On Ubuntu: sudo apt install libreoffice

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCX="$SCRIPT_DIR/OSAWARE_BASIC_Manual.docx"
PDF="$SCRIPT_DIR/OSAWARE_BASIC_Manual.pdf"

if [ ! -f "$DOCX" ]; then
  echo "ERROR: $DOCX not found"
  exit 1
fi

echo "Converting $DOCX -> PDF..."

if command -v soffice >/dev/null 2>&1; then
  soffice --headless --convert-to pdf --outdir "$SCRIPT_DIR" "$DOCX"
elif command -v libreoffice >/dev/null 2>&1; then
  libreoffice --headless --convert-to pdf --outdir "$SCRIPT_DIR" "$DOCX"
else
  echo "ERROR: LibreOffice not found."
  echo "  macOS:  brew install --cask libreoffice"
  echo "  Ubuntu: sudo apt install libreoffice"
  exit 1
fi

if [ -f "$PDF" ]; then
  echo "Done: $(du -sh "$PDF" | cut -f1)  $PDF"
else
  echo "ERROR: conversion failed"
  exit 1
fi
