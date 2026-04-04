#!/bin/bash
curl -s "http://localhost:3002/api/usage/consumption?from=2026-03-01&to=2026-04-03" | python3 -m json.tool | grep -A5 labXml
