import type { SkinCreateOpts } from './skin-types.js';
import { ADVENTURE_ACTIONS, SPRITE_W, SPRITE_H, SPRITE_FRAMES, SPRITE_DIRECTIONS, type AdventureAction } from './adventure-frames.js';

type Point = [number, number];

/** Original adventure-game cels on a 48×96 grid, with hand-placed shade clusters. */
export function drawAdventureAtlas(opts: SkinCreateOpts, separateSeatedArms = false): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_W * SPRITE_FRAMES;
  canvas.height = SPRITE_H * SPRITE_DIRECTIONS * ADVENTURE_ACTIONS.length;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  const tone = (n: number, factor: number, lift = 0) => hex(
    (Math.min(255, Math.round(((n >> 16) & 255) * factor + lift)) << 16) |
    (Math.min(255, Math.round(((n >> 8) & 255) * factor + lift)) << 8) |
    Math.min(255, Math.round((n & 255) * factor + lift)),
  );
  const p = {
    ink: '#252432', deep: '#33323d',
    skin: hex(opts.palette.skin), skinLight: tone(opts.palette.skin, 0.9, 28),
    skinMid: tone(opts.palette.skin, 0.82), skinShade: tone(opts.palette.skin, 0.62),
    skinDeep: tone(opts.palette.skin, 0.43),
    hair: hex(opts.palette.hair), hairLight: tone(opts.palette.hair, 0.86, 40),
    hairMid: tone(opts.palette.hair, 0.78), hairShade: tone(opts.palette.hair, 0.48),
    shirt: '#ded9bd', shirtLight: '#f9edcd', shirtMid: '#bbbba6',
    shirtShade: '#898e86', shirtDeep: '#626e70',
    vest: '#354e60', vestLight: '#526b78', vestShade: '#293c50',
    pants: hex(opts.palette.pants), pantsLight: tone(opts.palette.pants, 0.95, 19),
    pantsShade: tone(opts.palette.pants, 0.65),
    sash: opts.flowColor, sashLight: tone(parseInt(opts.flowColor.replace('#', ''), 16), 0.8, 35),
    sashShade: tone(parseInt(opts.flowColor.replace('#', ''), 16), 0.6),
    leather: '#514234', leatherLight: '#786047', leatherShade: '#322d2c',
    gold: '#d2b46c', goldShade: '#8b724d',
  };
  function rect(x: number, y: number, w: number, h: number, color: string) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }
  // Scanline fill keeps diagonal edges on the pixel grid, with no antialiasing.
  function poly(points: Point[], color: string) {
    ctx.fillStyle = color;
    const top = Math.min(...points.map(v => v[1])), bottom = Math.max(...points.map(v => v[1]));
    for (let y = Math.ceil(top); y < bottom; y++) {
      const intersections: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if ((a[1] <= y + 0.5 && b[1] > y + 0.5) || (b[1] <= y + 0.5 && a[1] > y + 0.5)) {
          intersections.push(a[0] + (y + 0.5 - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
        }
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const x = Math.ceil(intersections[i]);
        ctx.fillRect(x, y, Math.ceil(intersections[i + 1]) - x, 1);
      }
    }
  }
  function line(a: Point, b: Point, width: number, color: string) {
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let i = 0; i <= steps; i++) {
      rect(a[0] + (b[0] - a[0]) * i / steps - width / 2,
        a[1] + (b[1] - a[1]) * i / steps - width / 2, width, width, color);
    }
  }
  function boot(x: number, y: number, far: boolean) {
    poly([[x - 3,y - 7],[x + 3,y - 7],[x + 3,y - 2],[x + 7,y],[x + 7,y + 3],[x - 4,y + 3]], p.ink);
    rect(x - 2, y - 6, 4, 5, far ? p.leatherShade : p.leather);
    rect(x - 3, y - 6, 6, 2, far ? p.leather : p.leatherLight);
    rect(x - 2, y, 7, 2, p.leather);
    rect(x, y - 1, 4, 1, p.leatherLight);
    rect(x - 3, y + 2, 9, 1, p.leatherShade);
    rect(x - 2, y - 4, 1, 3, far ? p.leather : p.leatherLight);
  }
  function leg(hip: Point, knee: Point, ankle: Point, far: boolean) {
    line(hip, knee, 7, p.ink);
    line(knee, ankle, 6, p.ink);
    line([hip[0],hip[1] + 1], knee, 5, far ? p.pantsShade : p.pants);
    line(knee, ankle, 4, far ? p.pants : p.pantsLight);
    line([hip[0] - 1, hip[1] + 2], [knee[0] - 1,knee[1] - 2], 1, p.pantsLight);
    rect(knee[0] - 2, knee[1], 4, 1, p.pantsShade);
    rect(knee[0] - 1, knee[1] + 2, 3, 1, p.pantsShade);
    boot(ankle[0], ankle[1] + 1, far);
  }
  function arm(shoulder: Point, elbow: Point, hand: Point, far: boolean) {
    line(shoulder, elbow, 8, p.ink);
    line(shoulder, elbow, 6, far ? p.shirtShade : p.shirt);
    line([shoulder[0] - 1,shoulder[1]], [elbow[0] - 1,elbow[1] - 1], 2, far ? p.shirtMid : p.shirtLight);
    line(elbow, hand, 5, p.skinShade);
    line(elbow, [hand[0] - 1, hand[1] - 1], 3, far ? p.skinMid : p.skin);
    // Rolled cuff and warm reflected light along the exposed forearm.
    rect(elbow[0] - 3, elbow[1] - 2, 7, 3, p.shirtMid);
    rect(elbow[0] - 3, elbow[1] - 2, 6, 1, p.shirtLight);
    rect(elbow[0] + 2, elbow[1] - 1, 1, 1, p.goldShade);
    rect(hand[0] - 2, hand[1] - 1, 5, 4, p.skinShade);
    rect(hand[0] - 2, hand[1] - 1, 4, 2, far ? p.skinMid : p.skinLight);
    rect(hand[0] + 2, hand[1], 1, 2, p.skinDeep);
    rect(hand[0] - 1, hand[1] + 2, 1, 1, p.skinMid);
  }
  function face(direction: number, talking: boolean, blink: boolean, frame: number) {
    // Layered hair masses rather than a rectangular cap.
    poly([[18,8],[22,5],[30,5],[34,8],[36,14],[35,24],[32,30],[20,29],[16,23],[16,14]], p.ink);
    poly([[19,8],[23,6],[30,7],[33,10],[34,17],[31,27],[19,26],[17,21],[17,14]], p.hairShade);
    poly([[18,13],[20,8],[27,7],[32,9],[33,13],[28,15],[20,17]], p.hair);
    poly([[20,10],[23,8],[29,8],[32,10],[27,10],[22,13],[18,16]], p.hairLight);
    line([20,13],[25,10],1,p.hairMid);
    line([18,18],[20,14],1,p.hairLight);
    const tail = frame % 4 === 1 ? 1 : 0;
    poly([[17,22],[20,23],[20 + tail,29],[18 + tail,35],[15 + tail,36],[16,29],[15,26]], p.hairShade);
    line([18,26],[17 + tail,33],2,p.hair);
    rect(17,26,3,2,p.sashShade);
    if (direction === 2) {
      poly([[20,12],[28,10],[33,14],[32,23],[28,30],[21,28],[18,22]], p.hair);
      line([22,13],[21,25],1,p.hairLight);
      line([26,12],[25,27],1,p.hairMid);
      line([30,14],[28,28],1,p.hairShade);
      rect(25,26,4,2,p.sash);
      rect(25,28,3,5,p.hairShade);
      return;
    }
    if (direction === 1) {
      // A dedicated profile: forehead, nose bridge, lips and chin share one
      // continuous contour instead of adding a nose to the frontal face.
      poly([[24,14],[30,14],[33,17],[33,21],[36,23],[36,24],[33,25],[34,27],[33,29],[30,32],[26,31],[23,28],[22,23]],p.skinShade);
      poly([[25,16],[30,16],[32,19],[31,22],[34,23],[33,24],[31,25],[32,28],[29,30],[26,29],[25,26]],p.skin);
      poly([[26,17],[30,17],[31,19],[29,21],[26,21]],p.skinLight);
      rect(32,23,3,1,p.skinLight);
      rect(31,25,2,1,p.skinMid);
      rect(31,27,3,talking ? 2 : 1,p.skinDeep);
      if (talking) rect(32,27,1,1,p.shirt);
      rect(29,30,2,1,p.skinLight);
      rect(29,19,3,1,p.hairShade);
      rect(30,21,2,1,blink ? p.skinMid : '#e4ddbe');
      if (!blink) rect(31,21,1,1,p.ink);
      // Ear and sideburn, with a swept lock breaking the forehead edge.
      poly([[22,20],[25,20],[26,23],[24,26],[22,25]],p.skinMid);
      rect(23,22,1,2,p.skinDeep);
      rect(24,21,1,1,p.skinLight);
      poly([[19,13],[24,11],[31,12],[33,15],[29,15],[27,17],[25,17],[24,20],[22,21],[21,17]],p.hair);
      line([22,13],[29,13],1,p.hairLight);
      line([21,16],[23,14],1,p.hairMid);
      rect(21,19,1,5,p.hairShade);
      return;
    }
    // Jaw, cheek, temples, ear and nose have separate shade clusters.
    poly([[22,14],[31,13],[34,18],[34,27],[30,32],[25,32],[21,28],[20,20]], p.skinShade);
    poly([[24,15],[31,15],[33,20],[32,27],[29,30],[25,29],[23,25],[22,19]], p.skin);
    poly([[25,16],[30,16],[31,20],[29,22],[25,21],[23,19]], p.skinLight);
    poly([[23,24],[27,25],[30,24],[31,27],[28,29],[25,28]], p.skinMid);
    rect(21,21,2,5,p.skinMid);
    rect(21,22,1,2,p.skinDeep);
    rect(23,28,2,2,p.skinDeep);
    rect(27,30,3,1,p.skinLight);
    // Swept forelock breaks the forehead contour.
    poly([[19,13],[24,11],[32,11],[33,15],[28,14],[25,17],[23,16],[22,19],[20,20]], p.hair);
    line([23,13],[29,12],1,p.hairLight);
    rect(21,17,1,5,p.hairMid);
    {
      rect(24,19,3,1,p.hairShade);
      rect(30,19,3,1,p.hairShade);
      rect(24,21,3,1,blink ? p.skinShade : '#ece8ce');
      rect(30,21,3,1,blink ? p.skinShade : '#ece8ce');
      if (!blink) { rect(26,21,1,1,p.ink); rect(31,21,1,1,p.ink); }
      line([28,21],[28,24],1,p.skinShade);
      rect(28,24,2,1,p.skinLight);
      rect(27,27,4,talking ? 2 : 1,p.skinDeep);
      if (talking) rect(28,27,2,1,p.shirt);
      rect(27,29,3,1,p.skinLight);
    }
  }
  function draw(action: AdventureAction, frame: number, direction: number) {
    const cycle = frame * Math.PI / 4;
    const walking = action === 'walk', typing = action === 'typing';
    const seated = opts.walker === false && !walking;
    const stride = walking ? [7,5,0,-5,-7,-5,0,5][frame] : 0;
    const lift = walking ? Math.round(Math.max(0, Math.cos(cycle)) * 3) : 0;
    const bob = walking ? [0,-1,-2,-1,0,-1,-2,-1][frame] : action === 'talk' && frame === 2 ? -1 : 0;
    ctx.translate(0, bob + (seated ? 8 : 0));
    const profile = direction === 1;
    const farHip: Point = [profile ? 25 : 22,64];
    const nearHip: Point = [profile ? 27 : 29,65];
    if (seated) {
      // Foreshortened thighs from the front; bent knees in the profile view.
      const reach = profile ? 10 : 1;
      leg(farHip, [farHip[0] + reach,67], [farHip[0] + reach,83],true);
      leg(nearHip, [nearHip[0] + reach,68], [nearHip[0] + reach,85],false);
    } else {
      const passing = walking && (frame === 2 || frame === 6);
      leg(farHip, [farHip[0] - Math.round(stride * .35),77],
        [farHip[0] - stride,90 - lift - (passing && frame === 2 ? 3 : 0)],true);
      leg(nearHip, [nearHip[0] + Math.round(stride * .35),78],
        [nearHip[0] + stride,91 - (walking ? 3 - lift : 0) - (passing && frame === 6 ? 3 : 0)],false);
    }
    // Arm gestures use bent elbows, keeping the hands inside each atlas cell.
    let farElbow: Point = [17,51], farHand: Point = [17 + Math.round(stride * .5),62];
    let nearElbow: Point = [35,52], nearHand: Point = [35 - Math.round(stride * .6),64];
    if (typing || (seated && action === 'idle')) {
      const tap = typing ? [0,0,1,0,0,1,1,0][frame] : 0;
      farElbow=[17,47];farHand=[profile ? 30 : 22,45 + tap];
      nearElbow=[35,47];nearHand=[profile ? 42 : 32,45 + (typing ? 1 - tap : 0)];
    } else if (action === 'talk') {
      nearElbow=[36,48];nearHand=[40,43 + Math.round(Math.sin(cycle) * 4)];
    } else if (action === 'stretch') {
      farElbow=[13,33];farHand=[17,22];
      nearElbow=[39,32];nearHand=[36,20];
    }
    if (!seated || !separateSeatedArms) arm([19,39],farElbow,farHand,true);
    ctx.save();
    if (profile) { ctx.translate(26,0);ctx.scale(.78,1);ctx.translate(-26,0); }
    // Loose ivory shirt, dark waistcoat, tapered hips.
    poly([[21,35],[29,34],[34,37],[36,43],[33,54],[33,63],[29,68],[21,67],[18,61],[18,45],[17,39]],p.ink);
    poly([[21,36],[29,35],[33,38],[34,45],[31,53],[32,61],[20,62],[19,52],[19,41]],p.shirtShade);
    poly([[22,37],[29,36],[32,39],[32,49],[29,57],[22,59],[20,51],[20,42]],p.shirt);
    poly([[22,39],[25,38],[26,46],[24,54],[21,50]],p.shirtLight);
    line([25,47],[27,54],1,p.shirtMid);
    line([22,55],[25,56],1,p.shirtDeep);
    line([28,51],[30,47],1,p.shirtMid);
    // Vest panels frame the open shirt. Back has its own seam and cinch strap.
    if (direction === 2) {
      poly([[21,35],[30,35],[33,39],[32,61],[20,61],[19,43]],p.vestShade);
      poly([[22,37],[29,36],[31,40],[30,58],[21,58]],p.vest);
      line([26,38],[26,57],1,p.vestLight);
      rect(21,54,10,2,p.leather);
      rect(25,54,3,3,p.goldShade);
      rect(26,55,1,1,p.ink);
      line([21,42],[23,49],1,p.vestLight);
    } else {
      poly([[21,35],[24,37],[22,45],[23,58],[20,62],[19,53],[19,42]],p.vestShade);
      poly([[30,35],[33,38],[33,52],[31,61],[28,59],[29,46],[27,39]],p.vest);
      line([30,39],[30,48],1,p.vestLight);
      line([20,40],[20,51],1,p.vestLight);
      rect(30,52,1,2,p.gold);
      rect(30,56,1,1,p.goldShade);
      // Collar folds and the neck shadow sit above the vest lapels.
      poly([[24,30],[29,30],[29,35],[31,37],[27,42],[23,38]],p.skinShade);
      poly([[25,31],[28,31],[28,35],[29,37],[26,39],[24,36]],p.skin);
      poly([[23,34],[26,38],[24,43],[21,38]],p.shirtLight);
      poly([[29,34],[32,37],[29,42],[27,38]],p.shirtLight);
      line([24,39],[24,42],1,p.shirtShade);
    }
    rect(20,60,13,5,p.sashShade);
    rect(20,60,12,2,p.sash);
    rect(21,60,9,1,p.sashLight);
    poly([[30,61],[34,63],[32,69],[30,72],[28,70],[30,66]],p.sashShade);
    rect(31,64,1,4,p.sash);
    rect(20,65,12,2,p.leatherShade);
    rect(25,64,4,4,p.goldShade);
    rect(25,64,3,1,p.gold);
    rect(26,65,2,2,p.leatherShade);
    rect(21,67,1,3,p.leatherLight);
    ctx.restore();
    if (!seated || !separateSeatedArms) arm([33,39],nearElbow,nearHand,false);
    // A few broken folds avoid the appearance of smooth vector bands.
    if (!seated || !separateSeatedArms) {
      rect(32,42,1,2,p.shirtShade);
      rect(34,45,1,2,p.shirtMid);
    }
    face(direction,action === 'talk' && frame % 3 !== 0,action === 'idle' && frame === 7,frame);
  }
  ADVENTURE_ACTIONS.forEach((action, a) => {
    for (let direction = 0; direction < SPRITE_DIRECTIONS; direction++) {
      for (let frame = 0; frame < SPRITE_FRAMES; frame++) {
        ctx.save();
        ctx.translate(frame * SPRITE_W, (a * SPRITE_DIRECTIONS + direction) * SPRITE_H);
        draw(action, frame, direction);
        ctx.restore();
      }
    }
  });
  return canvas;
}
