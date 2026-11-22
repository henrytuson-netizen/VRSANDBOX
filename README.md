# VR Grid Sandbox

A WebXR sandbox: an empty grid floor, tracked hands (or controllers), and a few test objects you can grab and throw.

- `index.html`: page shell and import map (Three.js 0.160.0 from jsDelivr)
- `main.js`: scene, grid, test objects, hand-joint visuals, grabbing, physics-lite

## What's in it

- **Grid floor**: 40 m × 40 m, 1 m cells, at y = 0 (XR `local-floor` space).
- **Hands**: each tracked hand gets a sphere per joint and bone lines between joints. Left is cyan, right is orange.
- **Controllers**: if no hands are tracked, you get a pointing ray and a simple grip body.
- **Test objects**: cube, sphere, cylinder, cone, torus, octahedron, small cube. Two static reference pillars (1 m cube, 2 m tall box) show scale.
- **Grabbing**: trigger or pinch picks up the object under the ray, or the nearest one within 15 cm. Releasing throws it with your hand's velocity.
- **Desktop preview**: without a headset, drag to orbit and press **R** to reset objects.

## Run it

WebXR needs a secure context. `localhost` counts; a headset on your network does not, so it needs HTTPS.

Desktop preview (no headset):

```bash
cd vr-grid
python3 -m http.server 8000
```

Then open http://localhost:8000.

Headset: serve over HTTPS and open the URL in the headset browser (Quest Browser, for example). Hand tracking must be enabled in the headset's settings. One way to get HTTPS quickly is a tunnel such as `npx localtunnel --port 8000` or `ngrok http 8000`.

## Notes

- Three.js is loaded from a CDN, so the page needs internet access.
- Hand joint visuals are built lazily once hand tracking connects.
- Physics is intentionally minimal (gravity, floor bounce, friction). There are no object-to-object collisions.
