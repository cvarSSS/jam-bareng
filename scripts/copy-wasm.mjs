// Salin berkas wasm MediaPipe ke public/ agar disajikan dari domain sendiri.
import { cpSync, mkdirSync } from 'node:fs';

const from = 'node_modules/@mediapipe/tasks-vision/wasm';
const to = 'public/mediapipe';
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
