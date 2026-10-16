import type { SkinDefinition } from './skin-types.js';
import { createAdventureWorker, initAdventureWorker } from './adventure-worker.js';
import { drawExpressiveAtlas, type ExpressiveCharacter } from './expressive-atlas.js';

function character(kind: ExpressiveCharacter,name:string,skin:number,hair:number,pants:number,sleeve:number):SkinDefinition {
  return {
    manifest:{id:`${kind}-2d`,name,description:'1990s adventure-game pixel art with angular shading, expressive brows and animated speech.',author:'core',version:'1.0.0',category:'humanoid'},
    init:initAdventureWorker,
    pickPalette:()=>({skin,hair,pants}),
    createHumanoid:(opts)=>createAdventureWorker(opts,(o,separate)=>drawExpressiveAtlas(o,separate ?? false,kind),sleeve),
  };
}
export const inventor2DSkin=character('inventor','Inventor 2D',0xe6b38c,0xc67d43,0x334b67,0x4b9693);
export const detective2DSkin=character('detective','Detective 2D',0xc59775,0x584337,0x3e3e4c,0xb3a080);
export const robot2DSkin=character('robot','Cyborg 94 2D',0xbd967d,0x393c46,0x354756,0x617f8c);
