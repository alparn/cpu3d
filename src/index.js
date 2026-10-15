// Public entry point for using cpu3d as a library (browser or Node).
export * from './geometry.js';
export { Renderer, Mesh, Camera } from './renderer.js';
export { mat4, vec3 } from './math.js';
export { buildShape, SHAPE_REFERENCE, SHAPE_TYPES } from './recipes.js';
export { SceneDocument, createEmptyScene } from './document.js';
export { buildRenderScene, cameraFromState } from './scene.js';
export { TOOLS, callTool, toolList, toolListOpenAI, AGENT_GUIDE } from './tools.js';
