#!/bin/bash
# Doppio click nel Finder: apre il Terminale, avvia l'editor e il browser.
# Per chiuderlo: Ctrl+C nel Terminale, o chiudi la finestra.
cd "$(dirname "$0")/.." || exit 1
exec python3 _editor/server.py
