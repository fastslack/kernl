// Ambient declarations for the loaders the office3d realism layer imports
// (three ships its jsm examples without .d.ts; see three-examples.d.ts).
declare module 'three/examples/jsm/loaders/HDRLoader.js' {
  export class HDRLoader {
    loadAsync(url: string): Promise<any>;
  }
}

declare module 'three/examples/jsm/loaders/GLTFLoader.js' {
  export class GLTFLoader {
    setMeshoptDecoder(decoder: any): this;
    loadAsync(url: string): Promise<{ scene: any }>;
  }
}

declare module 'three/examples/jsm/libs/meshopt_decoder.module.js' {
  export const MeshoptDecoder: any;
}
