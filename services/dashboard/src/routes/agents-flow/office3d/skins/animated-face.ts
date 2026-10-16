/** Facial cels: neutral, blink, focus, three speech shapes, smile and yawn. */
export function facialCel(action: string, seconds: number): number {
  const t = Math.max(0, seconds);
  if (t % 4.7 > 4.56) return 1;
  if (action === 'talk') return [3,4,5,4,3,0][Math.floor(t * 8) % 6];
  if (action === 'typing') return 2;
  if (action === 'stretch') return 7;
  return action === 'idle' && t % 8 > 5 ? 6 : 0;
}

/** A transparent, unfiltered expression atlas; no canvas or browser globals. */
export function facialPixels() {
  const size = 48, frames = 8, width = size * frames;
  const pixels = new Uint8Array(width * size * 4);
  const colors: Record<string, number[]> = {
    ink:[54,43,49,255], white:[247,242,222,255], iris:[75,102,113,255],
    pupil:[34,38,45,255], shine:[255,255,245,255], lip:[133,76,70,255],
    mouth:[77,39,45,255], tongue:[207,123,124,255], cheek:[216,131,114,65],
  };
  let frame = 0;
  function rect(x: number,y: number,w: number,h: number,color: string) {
    const rgba = colors[color];
    for (let py=Math.max(0,y);py<Math.min(size,y+h);py++) for (let px=Math.max(0,x);px<Math.min(size,x+w);px++) {
      pixels.set(rgba,((size-1-py)*width+frame*size+px)*4);
    }
  }
  function oval(x: number,y: number,w: number,h: number,color: string) {
    for(let py=0;py<h;py++) for(let px=0;px<w;px++) {
      if(((px+.5-w/2)/(w/2))**2+((py+.5-h/2)/(h/2))**2<=1) rect(x+px,y+py,1,1,color);
    }
  }
  for(frame=0;frame<frames;frame++) {
    const blink=frame===1, focus=frame===2;
    for(const x of [7,29]) {
      const near=x===7;
      // Eyelids and warm cheeks soften the face without changing its 3D skin.
      oval(x-1,23,12,5,'cheek');
      if(blink) {
        rect(x,19,11,2,'ink');rect(x+2,21,6,1,'ink');
      } else {
        oval(x-1,13,13,9,'ink');oval(x,14,11,7,'white');
        oval(x+(focus ? 4 : 3),14,5,7,'iris');
        rect(x+(focus ? 5 : 4),16,3,4,'pupil');
        rect(x+4,15,2,2,'shine');
        if(focus) rect(x,13,11,3,'ink');
      }
      const brow=focus ? (near ? 11 : 10) : frame===7 ? 8 : frame===6 ? 10 : 11;
      rect(x,brow,10,2,'ink');
      if(focus) rect(x+(near ? 7 : 0),brow+2,3,1,'ink');
      else rect(x+2,brow-1,6,1,'ink');
    }
    // The physical nose remains in the model; only its small nostril marks are drawn.
    rect(22,27,2,1,'lip');rect(26,27,2,1,'lip');
    if(frame===3) {
      oval(18,33,13,8,'mouth');rect(20,33,9,2,'white');oval(21,38,7,2,'tongue');
    } else if(frame===4) {
      oval(17,34,15,5,'mouth');rect(19,34,11,2,'white');
    } else if(frame===5 || frame===7) {
      oval(frame===7 ? 19 : 21,32,frame===7 ? 11 : 8,frame===7 ? 11 : 8,'mouth');
      oval(22,38,5,3,'tongue');
    } else if(frame===6) {
      rect(17,34,2,2,'lip');rect(19,36,11,2,'lip');rect(30,34,2,2,'lip');
      rect(19,35,11,1,'white');
    } else {
      rect(20,35,10,2,'lip');rect(18,34,3,1,'lip');
    }
  }
  return { pixels,width,height:size,frames };
}

/** Conform the drawing to the front of the skull: it never faces the camera independently. */
export function attachAnimatedFace(three: any, head: any) {
  const atlas=facialPixels();
  const texture=new three.DataTexture(atlas.pixels,atlas.width,atlas.height);
  texture.magFilter=texture.minFilter=three.NearestFilter;
  texture.colorSpace=three.SRGBColorSpace;
  texture.generateMipmaps=false;
  texture.repeat.set(1/atlas.frames,1);
  texture.needsUpdate=true;
  const geometry=new three.SphereGeometry(.137,24,16,Math.PI*.2,Math.PI*.6,Math.PI*.22,Math.PI*.58);
  const material=new three.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,alphaTest:.02,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  material.addEventListener('dispose',()=>texture.dispose());
  const drawing=new three.Mesh(geometry,material);
  drawing.scale.set(.86,1.16,.86);
  drawing.name='animated-face-drawing';
  head.add(drawing);
  return (seconds: number,action: string)=>{texture.offset.x=facialCel(action,seconds)/atlas.frames;};
}
