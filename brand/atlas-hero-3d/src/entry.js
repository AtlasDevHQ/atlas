// Bundle entry for the hero page. `bun build --minify` folds three plus the
// three loaders the page needs into one IIFE that is inlined at build time —
// the published Artifact runs under a strict CSP that admits no external
// script, so nothing may be fetched from a CDN at runtime.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

globalThis.THREE = THREE;
globalThis.GLTFLoader = GLTFLoader;
globalThis.OrbitControls = OrbitControls;
globalThis.RoomEnvironment = RoomEnvironment;
