#!/bin/bash
docker compose build --no-cache kernel dashboard && docker compose up -d kernel dashboard
