# Forge3D Clean Export Service

Render-friendly backend service that converts Forge3D scene JSON into a cleaned printable STL using headless Blender.

## Endpoint

- `GET /health`
- `POST /api/clean-export`

Request body:

```json
{
  "scene": {
    "gridCols": 14,
    "gridRows": 10,
    "hexGrid": [],
    "objects": []
  },
  "filename": "forge3d-export.stl"
}
```

Response:

- `200` with binary STL payload (`Content-Type: model/stl`)

## Environment Variables

- `PORT` (default: `10000`)
- `ASSET_ROOT` (default: `/app/assets` in Docker)
- `BLENDER_BIN` (default: `blender`)
- `EXPORT_TIMEOUT_MS` (default: `360000`)
- `CORS_ORIGIN` optional comma-separated origins

## Render Deploy

Create a new **Web Service** from this repo with:

- Runtime: `Docker`
- Dockerfile Path: `backend/Dockerfile` (if still inside this monorepo)
- If you move this folder to a standalone backend repo, Dockerfile path is just `Dockerfile`
- Branch: your deployment branch

Render will build the image with Blender + assets.

## Local Run (if Blender installed)

```bash
cd backend
npm install
npm start
```

## Standalone Repo Flow

If you want a separate GitHub repo:

1. Copy `backend` folder to a new directory.
2. `cd` into that directory.
3. `git init` and push to new GitHub repo.
4. Deploy that repo directly on Render with Docker runtime.
