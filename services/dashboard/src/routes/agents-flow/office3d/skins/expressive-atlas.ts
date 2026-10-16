import type { SkinCreateOpts } from './skin-types.js';
import { drawAdventureAtlas } from './adventure-atlas.js';
import { ADVENTURE_ACTIONS, SPRITE_W, SPRITE_H, SPRITE_FRAMES, SPRITE_DIRECTIONS } from './adventure-frames.js';

export type ExpressiveCharacter = 'inventor' | 'detective' | 'robot';

export function characterExpression(action: string, frame: number) {
  if (action === 'idle' && frame === 7) return 'blink';
  if (action === 'stretch') return 'surprised';
  if (action === 'typing') return 'focused';
  if (action === 'talk') return ['talk-open','talk-wide','talk-round','smile'][frame % 4];
  return 'smile';
}

/** Large readable faces and separate silhouettes, over the shared seated/walking cels. */
export function drawExpressiveAtlas(opts: SkinCreateOpts, separateArms: boolean, kind: ExpressiveCharacter) {
  const canvas=drawAdventureAtlas(opts,separateArms);
  const ctx=canvas.getContext('2d')!;
  const image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const palettes = {
    inventor:['#4b9693','#88c9b1','#367579','#285563','#203e51','#9a5d39','#bd8753','#663f31'],
    detective:['#b3a080','#dfcba2','#8c7b66','#665c53','#403f45','#6f3f48','#986060','#452d3a'],
    robot:['#91afb4','#c5d9ce','#617f8c','#435d72','#29394f','#3b647b','#6b97a5','#233e54'],
  };
  const from=['ded9bd','f9edcd','bbbba6','898e86','626e70','354e60','526b78','293c50'];
  const replacements=new Map(from.map((color,i)=>[parseInt(color,16),parseInt(palettes[kind][i].slice(1),16)]));
  if(kind==='robot') {
    for(const [from,to] of [[0x514234,0x52697b],[0x786047,0x7e9eac],[0x322d2c,0x2c4057]]) replacements.set(from,to);
  }
  // Recolor only the clothes, leaving skin tones and team-color accents intact.
  for(let y=0;y<canvas.height;y++) {
    const action=Math.floor(y/SPRITE_H/SPRITE_DIRECTIONS);
    const seated=opts.walker===false && ADVENTURE_ACTIONS[action]!=='walk';
    if(y%SPRITE_H<35+(seated ? 8 : 0)) continue;
    for(let x=0;x<canvas.width;x++) {
      const i=(y*canvas.width+x)*4;
      const color=(image.data[i]<<16)|(image.data[i+1]<<8)|image.data[i+2];
      const replacement=replacements.get(color);
      if(replacement!==undefined) {image.data[i]=replacement>>16;image.data[i+1]=(replacement>>8)&255;image.data[i+2]=replacement&255;}
    }
  }
  ctx.putImageData(image,0,0);
  const hex=(color:number)=>`#${color.toString(16).padStart(6,'0')}`;
  const skin=hex(opts.palette.skin), hair=hex(opts.palette.hair);
  function rect(x:number,y:number,w:number,h:number,color:string) {
    ctx.fillStyle=color;ctx.fillRect(x,y,w,h);
  }
  function oval(x:number,y:number,w:number,h:number,color:string) {
    for(let py=0;py<h;py++) for(let px=0;px<w;px++) {
      if(((px+.5-w/2)/(w/2))**2+((py+.5-h/2)/(h/2))**2<=1) rect(x+px,y+py,1,1,color);
    }
  }
  const ink='#222633',cream='#f1dfbd';
  const tint=(color:number,k:number,lift=0)=>hex(
    (Math.min(255,Math.round(((color>>16)&255)*k+lift))<<16)|
    (Math.min(255,Math.round(((color>>8)&255)*k+lift))<<8)|
    Math.min(255,Math.round((color&255)*k+lift)));
  const shadow=tint(opts.palette.skin,.65), mid=tint(opts.palette.skin,.82),light=tint(opts.palette.skin,.9,27);
  const hairShade=tint(opts.palette.hair,.53),hairLight=tint(opts.palette.hair,.85,31);
  function poly(points:number[][],color:string) {
    for(let y=Math.min(...points.map(p=>p[1]));y<Math.max(...points.map(p=>p[1]));y++) {
      const hits:number[]=[];
      for(let i=0;i<points.length;i++) {
        const a=points[i],b=points[(i+1)%points.length];
        if((a[1]<=y+.5&&b[1]>y+.5)||(b[1]<=y+.5&&a[1]>y+.5)) hits.push(a[0]+(y+.5-a[1])*(b[0]-a[0])/(b[1]-a[1]));
      }
      hits.sort((a,b)=>a-b);
      for(let i=0;i+1<hits.length;i+=2)rect(Math.ceil(hits[i]),y,Math.ceil(hits[i+1])-Math.ceil(hits[i]),1,color);
    }
  }
  function features(profile:boolean,expression:string,frame:number) {
    const blink=expression==='blink',focus=expression==='focused',surprise=expression==='surprised';
    const talking=expression.startsWith('talk');
    const eyes=profile ? [30] : [23,30];
    for(const x of eyes) {
      const left=x<27;
      if(kind==='inventor') {
        // Alert, round eyes. A grin sometimes becomes a playful one-eye wink.
        const wink=expression==='smile' && frame===3 && !left;
        const height=surprise?5:focus?2:4;
        if(blink||wink) {rect(x-1,22,6,1,hairShade);rect(x,23,4,1,hairShade);}
        else {
          oval(x-1,19,6,height+1,ink);oval(x,19,5,height,cream);
          rect(x+(focus?(left?3:1):2),20,2,Math.max(1,height-1),'#426f75');
          rect(x+2,19,1,1,cream);
        }
        const brow=surprise?14:focus?17:left?15:14;
        rect(x-1,brow,5,1,hairShade);rect(x+1,brow-1,3,1,hairShade);
        if(focus)rect(x+(left?3:0),18,2,1,hairShade);
      } else if(kind==='detective') {
        // Heavy half-lids and pupils looking sideways; one skeptical eyebrow.
        if(blink) rect(x-1,22,5,1,shadow);
        else {
          rect(x-1,20,5,surprise?3:2,cream);rect(x+(left?0:1),20,1,surprise?3:2,ink);
          rect(x-1,19,5,focus?3:2,hairShade);
        }
        const brow=left?(surprise?14:15):(focus?18:17);
        rect(x-2,brow,6,1,hairShade);rect(x-1,brow-1,3,1,hairShade);
        if(focus)rect(x-2,23,5,1,mid);
      } else {
        // The organic eye stays restrained; the optic carries most reactions.
        rect(x-1,18,6,2,ink);
        if(!blink) {rect(x,20,4,surprise?3:1,cream);rect(x+2,20,1,surprise?3:1,ink);}
        else rect(x,21,4,1,shadow);
      }
    }
    if(profile) {
      poly([[33,21],[35,22],[37,24],[36,25],[33,25]],mid);
      rect(34,23,2,1,light);rect(33,25,2,1,shadow);
    } else {
      rect(28,21,1,4,mid);rect(29,25,2,1,shadow);rect(28,24,2,1,light);
      rect(23,24,2,1,mid);rect(32,24,2,1,light);
    }
    const mx=profile?32:26;
    if(kind==='inventor') {
      if(surprise || expression==='talk-open') {
        oval(mx-1,27,7,surprise?6:5,ink);rect(mx,27,5,1,cream);rect(mx+1,31,3,1,'#d89383');
      } else if(expression==='talk-round') oval(mx+1,27,4,5,ink);
      else if(focus) {rect(mx,28,4,1,shadow);rect(mx+4,28,2,2,'#cf8c78');}
      else {rect(mx-2,27,9,3,ink);rect(mx-1,27,7,1,cream);rect(mx,30,4,1,light);}
    } else if(kind==='detective') {
      if(surprise) {rect(mx+1,28,3,3,ink);rect(mx+2,28,1,1,cream);}
      else if(talking) {
        rect(mx-1,28,6,expression==='talk-open'?3:2,ink);
        rect(mx+2,28,3,1,cream);rect(mx-2,29,2,1,shadow);
      } else {
        // Crooked smirk, never the inventor's broad toothy smile.
        rect(mx-2,29,6,1,shadow);rect(mx+3,27,2,2,shadow);rect(mx+1,30,3,1,light);
      }
      rect(mx-3,26,4,2,hairShade);rect(mx+2,26,3,1,hairShade);
      rect(mx-3,25,2,1,hairShade);
    } else {
      // A clipped jaw and minimal speech shapes emphasize the mechanical face.
      rect(mx-1,28,7,1,ink);
      if(talking) {rect(mx+1,29,expression==='talk-open'?4:2,1,ink);rect(mx+2,28,2,1,cream);}
      if(surprise)rect(mx+2,29,2,2,ink);
      const ex=profile?30:22;
      rect(ex-1,18,7,5,'#313b49');
      rect(ex,19,5,3,'#6b3737');
      const optic=surprise?'#ffce73':focus?'#ff8b48':'#f05b48';
      if(blink)rect(ex,20,5,1,'#805044');
      else {
        rect(ex+(focus?frame%3:1),19,surprise?4:2,3,optic);
        rect(ex+1,19,1,1,'#ffe1a8');
        if(talking)rect(ex-1,24,2+(frame%3),1,'#d76c52');
      }
      if(focus)rect(ex+4,17,1,1,'#ffce73');
    }
  }
  function drawHead(direction:number,expression:string,frame:number) {
    const profile=direction===1,back=direction===2;
    rect(24,31,5,7,shadow);rect(25,32,3,5,skin);
    // Angular hair, cheek and jaw clusters use a compact 16-bit-era palette.
    poly([[20,9],[24,6],[30,6],[34,9],[35,16],[34,27],[30,33],[25,33],[21,28],[18,20],[18,13]],ink);
    poly([[20,11],[23,8],[29,7],[33,10],[34,18],[32,28],[23,29],[19,21]],hairShade);
    poly([[20,11],[24,8],[29,8],[32,11],[29,16],[21,18]],hair);
    poly([[21,10],[25,8],[30,9],[26,10],[21,14],[19,17]],hairLight);
    if(kind==='inventor') {
      poly([[19,23],[20,28],[18,34],[15,35],[16,29],[16,25]],hairShade);
      rect(17,27,2,5,hair);rect(17,26,3,2,opts.flowColor);
    }
    if(back) {
      poly([[22,12],[30,10],[33,15],[31,26],[27,31],[22,28],[20,20]],hair);
      rect(23,13,1,12,hairLight);rect(27,12,1,16,hairShade);
      if(kind==='robot') {rect(23,23,8,5,'#596b79');rect(25,25,4,1,'#bac9c4');}
    } else {
      poly([[24,14],[30,14],[33,18],[34,25],[31,30],[28,33],[24,31],[21,26],[21,20]],shadow);
      poly([[25,15],[30,15],[32,19],[32,26],[29,30],[26,30],[23,26],[23,20]],skin);
      poly([[26,16],[30,16],[31,19],[29,22],[25,21],[24,19]],light);
      poly([[24,25],[27,26],[31,24],[31,27],[28,29],[25,28]],mid);
      rect(21,21,2,5,mid);rect(21,22,1,2,shadow);
      // A swept forelock and a proper temple leave the eyes uncovered.
      poly([[20,13],[24,11],[32,12],[32,15],[28,15],[25,18],[23,17],[22,21],[20,20]],hair);
      rect(23,12,6,1,hairLight);rect(20,18,1,6,hairShade);
      if(kind==='robot') {
        poly([[20,14],[24,13],[26,16],[25,24],[27,28],[25,31],[22,29],[20,24]],'#596b79');
        poly([[21,15],[24,15],[25,17],[24,23],[22,25],[21,22]],'#a7b4b3');
        rect(21,16,1,5,'#dde0c9');rect(22,24,2,3,'#394c5b');
        rect(23,28,3,2,'#879b9e');rect(21,18,1,1,'#d9d6b8');
        rect(20,25,1,3,'#bd644e');
      }
      features(profile,expression,frame);
    }
    if(kind==='inventor') {
      // Brass goggles on the forehead, with tiny lens highlights.
      rect(20,10,5,4,'#6c5239');rect(28,10,5,4,'#6c5239');rect(25,11,3,1,'#bc965b');
      rect(21,11,3,2,'#618e91');rect(29,11,3,2,'#618e91');
      rect(21,11,1,1,'#c5d7bc');rect(29,11,1,1,'#c5d7bc');
    }
    if(kind==='detective') {
      // Narrow fedora with a dented crown and broken rim highlights.
      poly([[19,7],[22,3],[28,4],[31,3],[34,7],[34,12],[18,12]],'#514a42');
      poly([[21,6],[23,4],[27,6],[31,4],[32,8],[22,9]],'#928069');
      rect(19,10,15,2,'#37383d');rect(14,12,25,2,'#514a42');rect(17,12,17,1,'#b29b76');
      rect(17,14,17,1,'#353842');
    }
  }
  ADVENTURE_ACTIONS.forEach((action,a)=>{
    for(let direction=0;direction<SPRITE_DIRECTIONS;direction++) for(let frame=0;frame<SPRITE_FRAMES;frame++) {
      const seated=opts.walker===false && action!=='walk';
      ctx.save();ctx.translate(frame*SPRITE_W,(a*SPRITE_DIRECTIONS+direction)*SPRITE_H);
      ctx.clearRect(4,0,40,35+(seated?8:0));ctx.translate(0,seated?8:0);
      drawHead(direction,characterExpression(action,frame),frame);
      // Each outfit carries a readable prop rather than relying on palette alone.
      if(kind==='inventor') {rect(19,48,3,9,'#d5b464');rect(20,47,3,2,ink);rect(31,50,3,5,'#dfb062');}
      if(kind==='detective') {rect(26,40,2,13,'#67404b');rect(25,51,4,3,'#67404b');rect(31,44,3,4,'#e3c879');}
      if(kind==='robot') {rect(21,43,11,12,'#29394f');rect(22,44,9,3,'#879b9e');rect(23,45,6,1,'#b4c4bd');rect(23,49,7,1,'#596b79');rect(23,52,3,1,'#d27359');rect(19,57,3,4,'#617786');rect(32,55,2,5,'#617786');}
      ctx.restore();
    }
  });
  return canvas;
}
