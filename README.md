# Forge3D Clean Export Service (Trimesh-Only)

Lightweight backend service to clean raw STL from the frontend and return printable STL.

## Endpoints

- `GET /health`
- `GET /health/deps`
- `POST /api/clean-export-trimesh-stl` (primary)
- `POST /api/clean-export-stl` (compat alias; same trimesh cleaner)
- `POST /api/export-color-3mf` (scene JSON -> color 3MF)

### Request format (export endpoints)

- Body: raw STL binary
- Content-Type: `model/stl` or `application/octet-stream`
- Optional query: `?filename=forge3d-clean-export.stl`

### Response

- `200` with binary STL (`Content-Type: model/stl`)
- Headers include:
  - `X-Export-Job-Id`
  - `X-Export-Duration-Ms`
  - `X-Export-Mode`

### Color 3MF endpoint (`/api/export-color-3mf`)

- Request body JSON:
  - `tiles`: array of `{ q, r, biome }`
  - `objects`: array of `{ asset, q, r, rotationY, scale, localOffsetX, localOffsetZ }`
- Optional query: `?filename=forge3d-color-export.3mf`
- Response: binary 3MF (`Content-Type: model/3mf`)

## Environment Variables

- `PORT` (default: `10000`)
- `ASSET_ROOT` (default: `/app/assets`)
- `PYTHON_BIN` (default: `python3`)
- `TRIMESH_CLEAN_TIMEOUT_MS` (default: `120000`)
- `COLOR_3MF_TIMEOUT_MS` (default: `180000`)
- `MAX_PARALLEL_EXPORTS` (default: `1`)
- `CORS_ORIGIN` optional comma-separated origins

## Docker

The Docker image installs Python + `numpy` + `trimesh` only (no Blender).

## AWS redeploy

```bash
chmod +x scripts/redeploy_aws.sh
./scripts/redeploy_aws.sh
```

## Notes

- Legacy Blender/queue endpoints are retired and return `410`.
- Frontend should call `/api/clean-export-trimesh-stl`.
