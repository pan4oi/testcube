// Realistic Mode: drive the cube with hand gestures instead of the mouse.
//
// Gestures
//   pinch (thumb + index) or a closed fist over a sticker  -> grab that layer
//   move the grabbing hand                                 -> spin the layer
//   open the hand                                          -> snap to 90 degrees
//   open palm drag (one or two hands)                      -> orbit the whole cube
//
// Mapping
//   MediaPipe landmarks are image-normalized (0..1). They are mirrored (the
//   webcam preview is a mirror) and mapped to CSS pixels over the game canvas,
//   then raycast into the cube. The grabbed sticker gives a face normal and a
//   point. Screen-space hand movement is converted to a tangent on that face,
//   and the rotation axis is `r x t` quantized to the nearest cube axis - the
//   axis whose rotation actually moves the grabbed point along the drag.
//
// Every rotation goes through Controls.startHandLayer/rotateHandLayer/
// endHandLayer, so the timer, localStorage and the solved check behave exactly
// as for a mouse move.

const HAND = {
  WRIST: 0,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
};

const HAND_TIPS = [ HAND.THUMB_TIP, HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.RING_TIP, HAND.PINKY_TIP ];
const HAND_PIPS = [ HAND.THUMB_IP, HAND.INDEX_PIP, HAND.MIDDLE_PIP, HAND.RING_PIP, HAND.PINKY_PIP ];

const HAND_CONNECTIONS = [
  [ 0, 1 ], [ 1, 2 ], [ 2, 3 ], [ 3, 4 ],
  [ 0, 5 ], [ 5, 6 ], [ 6, 7 ], [ 7, 8 ],
  [ 5, 9 ], [ 9, 10 ], [ 10, 11 ], [ 11, 12 ],
  [ 9, 13 ], [ 13, 14 ], [ 14, 15 ], [ 15, 16 ],
  [ 13, 17 ], [ 17, 18 ], [ 18, 19 ], [ 19, 20 ],
  [ 0, 17 ],
];

const PINCH_START = 0.45;
const PINCH_END = 0.62;
const GRAB_DEADZONE = 14;
const ORBIT_DEADZONE = 18;

// Hand tracking drops a frame or two now and then. Hold the gesture together
// for this long before giving up, so a blink does not end a turn.
const LOST_GRACE = 180;

const SENSITIVITY_KEY = 'theCube_handsSensitivity';
const SENSITIVITY_DEFAULT = 1.15;
const SENSITIVITY_MIN = 0.6;
const SENSITIVITY_MAX = 2;

class RealisticMode {

  constructor( game ) {

    this.game = game;

    this.active = false;
    this.playing = false;
    this.hands = [];

    this.grab = null;
    this.orbit = null;
    this.pendingOrbit = null;
    this.hover = null;

    this.sensitivity = this.loadSensitivity();

    this.pinched = {};
    this.mouseSuppressed = false;
    this.startId = 0;
    this.starting = false;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.planePoint = new THREE.Vector3();
    this.cameraDirection = new THREE.Vector3();
    this.tmpQuaternion = new THREE.Quaternion();
    this.tmpScale = new THREE.Vector3();

    this.dom = {
      panel: document.querySelector( '.hands' ),
      toggle: document.querySelector( '.hands__toggle' ),
      video: document.querySelector( '.hands__video' ),
      overlay: document.querySelector( '.hands__overlay' ),
      status: document.querySelector( '.hands__status' ),
      cursor: document.querySelector( '.hand-cursor' ),
      cursorLabel: document.querySelector( '.hand-cursor__label' ),
      sensitivity: document.querySelector( '.hands__sensitivity' ),
      sensitivityValue: document.querySelector( '.hands__sensitivity-value' ),
    };

    this.preview = this.dom.overlay ? this.dom.overlay.getContext( '2d' ) : null;

    this.tracker = new HandTracker( {
      video: this.dom.video,
      basePath: './vendor/mediapipe',
    } );

    this.tracker.onHands = hands => this.onHands( hands );
    this.tracker.onStatus = ( status, error ) => this.onTrackerStatus( status, error );

    this.bindUi();
    this.setPlaying( false );

  }

  bindUi() {

    if ( this.dom.toggle ) {

      this.dom.toggle.addEventListener( 'click', event => {

        event.stopPropagation();
        this.toggle();

      }, false );

    }

    if ( this.dom.sensitivity ) {

      this.dom.sensitivity.value = this.sensitivity;
      this.updateSensitivityLabel();

      this.dom.sensitivity.addEventListener( 'input', () => {

        this.setSensitivity( parseFloat( this.dom.sensitivity.value ) );

      }, false );

    }

    window.addEventListener( 'keydown', event => {

      if ( event.repeat ) return;

      if ( event.key === 'h' || event.key === 'H' ) {

        if ( this.game.state === STATE.Playing ) this.toggle();

      } else if ( event.key === 'Escape' && this.active ) {

        this.deactivate();

      }

    }, false );

  }

  // The toggle only makes sense during a game. Game calls this from its state
  // machine so leaving the game turns the camera light off.
  setPlaying( playing ) {

    this.playing = playing;

    if ( this.dom.toggle ) this.dom.toggle.hidden = ! playing;
    if ( ! playing ) this.deactivate();

  }

  async toggle() {

    if ( this.active ) this.deactivate();
    else await this.activate();

  }

  async activate() {

    if ( this.active || this.starting ) return;

    if ( this.game.state !== STATE.Playing ) {

      this.flash( 'Start a game first' );
      return;

    }

    this.starting = true;
    this.active = true;

    const startId = ++ this.startId;

    this.dom.panel.hidden = false;
    this.dom.panel.classList.remove( 'is-error' );
    document.body.classList.add( 'hands-on' );

    if ( this.dom.toggle ) this.dom.toggle.classList.remove( 'is-error' );

    this.showStatus( 'Waiting for camera permission…' );

    try {

      await this.tracker.start();

      // The user may have switched the mode off, or left the game, while the
      // model was loading. Stop the camera that just came up.
      if ( startId !== this.startId || ! this.active ) {

        this.tracker.stop();
        return;

      }

    } catch ( error ) {

      if ( startId === this.startId ) {

        this.active = false;

        this.showStatus( error.message, 'error' );
        this.dom.panel.classList.add( 'is-error' );

        if ( this.dom.toggle ) this.dom.toggle.classList.add( 'is-error' );

      }

    } finally {

      if ( startId === this.startId ) this.starting = false;

    }

  }

  deactivate() {

    this.startId++;
    this.starting = false;

    if ( this.grab ) this.releaseGrab( true );
    if ( this.orbit ) this.endOrbit();

    this.active = false;
    this.hands = [];
    this.pendingOrbit = null;
    this.hover = null;
    this.pinched = {};

    if ( this.tracker ) this.tracker.stop();

    if ( this.dom.panel ) {

      this.dom.panel.hidden = true;
      this.dom.panel.classList.remove( 'is-error' );

    }

    if ( this.dom.cursor ) this.dom.cursor.hidden = true;
    if ( this.dom.toggle ) this.dom.toggle.classList.remove( 'is-error' );

    document.body.classList.remove( 'hands-on' );

  }

  onTrackerStatus( status, error ) {

    if ( status === 'camera' ) {

      this.showStatus( 'Waiting for camera permission…' );

    } else if ( status === 'model' ) {

      this.showStatus( 'Loading hand model…' );

    } else if ( status === 'running' ) {

      this.showStatus( 'Pinch a sticker and drag. Open palm drags the cube.' );

    } else if ( status === 'error' ) {

      // Never leave a grabbed layer (or the mouse) stuck if tracking dies
      // mid-gesture.
      if ( this.grab ) this.releaseGrab( true );
      if ( this.orbit ) this.endOrbit();

      this.pendingOrbit = null;
      this.active = false;

      this.dom.cursor.hidden = true;
      this.dom.panel.classList.add( 'is-error' );
      this.showStatus( error ? error.message : 'Hand tracking stopped.', 'error' );

    }

  }

  onHands( hands ) {

    if ( ! this.active ) return;

    this.hands = hands;

    this.drawPreview( hands );
    this.processHands( hands );

  }

  // ---------------------------------------------------------------------
  // Gesture state machine
  // ---------------------------------------------------------------------

  processHands( hands ) {

    const metrics = hands.map( hand => this.measureHand( hand ) );

    if ( this.grab ) {

      this.updateGrab( metrics );

    } else if ( this.orbit ) {

      this.updateOrbit( metrics );

    } else {

      this.updateIdle( metrics );

    }

    this.updateCursor( metrics );

  }

  measureHand( hand ) {

    const lm = hand.landmarks;
    const span = Math.max( this.distance( lm[ HAND.WRIST ], lm[ HAND.MIDDLE_MCP ] ), 0.0001 );
    const pinch = this.distance( lm[ HAND.THUMB_TIP ], lm[ HAND.INDEX_TIP ] ) / span;

    // Extension of the four fingers only. The thumb is unreliable in a
    // front-facing webcam, and an open palm should not require it.
    let fingers = 0;

    for ( let i = 1; i < HAND_TIPS.length; i++ ) {

      const tip = this.distance( lm[ HAND_TIPS[ i ] ], lm[ HAND.WRIST ] );
      const pip = this.distance( lm[ HAND_PIPS[ i ] ], lm[ HAND.WRIST ] );

      if ( tip > pip * 1.08 ) fingers++;

    }

    let pinched = this.pinched[ hand.id ] === true;

    if ( pinched && pinch > PINCH_END ) pinched = false;
    if ( ! pinched && pinch < PINCH_START ) pinched = true;

    this.pinched[ hand.id ] = pinched;

    // A closed fist grabs too, using the knuckles as the grab point.
    const fist = fingers === 0 && ! pinched;
    const grabPoint = fist
      ? lm[ HAND.MIDDLE_MCP ]
      : this.lerp( lm[ HAND.THUMB_TIP ], lm[ HAND.INDEX_TIP ], 0.5 );

    return {
      hand,
      id: hand.id,
      pinch,
      extended: fingers,
      pinched,
      fist,
      grab: pinched || fist,
      open: fingers === 4 && ! pinched,
      grabPoint,
      palm: this.lerp( lm[ HAND.WRIST ], lm[ HAND.MIDDLE_MCP ], 0.5 ),
    };

  }

  updateIdle( metrics ) {

    const controls = this.game.controls;

    const usable = this.playing
      && controls.enabled === true
      && controls.scramble === null
      && controls.state === STILL;

    if ( ! usable ) {

      this.pendingOrbit = null;
      this.hover = null;
      return;

    }

    // 1. Grab: a pinching or fisted hand resting on a sticker. While doing
    // this, remember any hand that is merely hovering a sticker so the cursor
    // can say "pinch to turn" before the user commits.

    let hover = null;

    for ( const metric of metrics ) {

      const screen = this.toScreen( metric.grabPoint );
      const hit = this.pickCube( screen );

      if ( ! hit ) continue;
      if ( ! hover ) hover = { id: metric.id, screen };

      if ( metric.grab ) {

        this.beginGrab( metric, hit );
        return;

      }

    }

    this.hover = hover;

    // 2. Orbit: one or two open palms. Wait for a deliberate drag before
    // starting so a hand hovering in frame does not spin the cube.

    const open = metrics.filter( metric => metric.open );

    if ( open.length === 0 ) {

      this.pendingOrbit = null;
      return;

    }

    const midpoint = this.midpoint( open.map( metric => this.toScreen( metric.palm ) ) );

    if ( ! this.pendingOrbit || this.pendingOrbit.count !== open.length ) {

      this.pendingOrbit = { start: midpoint, last: midpoint, count: open.length };
      return;

    }

    if ( midpoint.distanceTo( this.pendingOrbit.start ) < ORBIT_DEADZONE ) return;

    if ( ! controls.startHandOrbit() ) return;

    this.suppressMouse();

    this.hover = null;
    this.orbit = { last: midpoint, count: open.length, lostSince: 0 };
    this.pendingOrbit = null;

  }

  beginGrab( metric, hit ) {

    this.pendingOrbit = null;
    this.hover = null;

    const cube = this.game.cube;
    const world = hit.point.clone();
    const local = cube.object.worldToLocal( world.clone() );

    // Prefer the actual face that was hit over the dominant local coordinate:
    // on a corner both disagree, and the face is what the user grabbed.
    const normal = hit.face
      ? this.dominantAxis( this.toCubeDirection(
          hit.face.normal
            .clone()
            .applyMatrix3( new THREE.Matrix3().getNormalMatrix( hit.object.matrixWorld ) )
            .normalize()
        ) ).vector
      : this.dominantAxis( local ).vector;

    this.game.world.camera.getWorldDirection( this.cameraDirection );

    this.grab = {
      id: metric.id,
      piece: hit.object.parent,
      local,
      normal,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint( this.cameraDirection, world ),
      lastWorld: world,
      startScreen: this.toScreen( metric.grabPoint ),
      screen: this.toScreen( metric.grabPoint ),
      started: false,
      axis: null,
      direction: null,
      radius: 1,
      layer: null,
      angle: 0,
      lostSince: 0,
    };

    this.suppressMouse();

  }

  updateGrab( metrics ) {

    const grab = this.grab;

    const metric = metrics.find( item => item.id === grab.id );

    // Tracking lost: hold the layer still for a moment (MediaPipe drops the
    // odd frame), then snap whatever has been rotated so far.
    if ( ! metric ) {

      const now = performance.now();

      if ( ! grab.lostSince ) grab.lostSince = now;
      if ( now - grab.lostSince < LOST_GRACE ) return;

      this.releaseGrab( false );
      return;

    }

    grab.lostSince = 0;

    if ( ! metric.grab ) {

      this.releaseGrab( false );
      return;

    }

    const screen = this.toScreen( metric.grabPoint );
    grab.screen.copy( screen );

    if ( ! grab.started ) {

      if ( screen.distanceTo( grab.startScreen ) < GRAB_DEADZONE ) return;

      if ( ! this.startGrabRotation( screen ) ) {

        this.releaseGrab( true );
        return;

      }

      const anchor = this.projectToGrabPlane( screen );
      if ( anchor ) grab.lastWorld.copy( anchor );

      return;

    }

    const world = this.projectToGrabPlane( screen );
    if ( ! world ) return;

    const worldDelta = world.clone().sub( grab.lastWorld );
    grab.lastWorld.copy( world );

    const localDelta = this.toCubeDirection( worldDelta );
    const along = localDelta.dot( grab.direction );

    // Clamp per-frame rotation: a tracking jump should not spin the layer
    // by half a turn in one frame.
    const angle = THREE.Math.clamp( along / grab.radius, -0.35, 0.35 ) * this.sensitivity;

    if ( Math.abs( angle ) < 0.0005 ) return;

    if ( this.game.controls.rotateHandLayer( angle ) ) {

      grab.angle += angle;

    }

  }

  startGrabRotation( screen ) {

    const grab = this.grab;
    const camera = this.game.world.camera;

    // Screen-aligned directions expressed in cube-local space.
    const worldRight = new THREE.Vector3().setFromMatrixColumn( camera.matrixWorld, 0 ).normalize();
    const worldUp = new THREE.Vector3().setFromMatrixColumn( camera.matrixWorld, 1 ).normalize();

    const right = this.toCubeDirection( worldRight );
    const up = this.toCubeDirection( worldUp );

    const horizontal = Math.abs( grab.screen.x - grab.startScreen.x ) >= Math.abs( grab.screen.y - grab.startScreen.y );
    const tangent = ( horizontal ) ? right : up;

    // The drag has to happen on the face that was grabbed.
    tangent.addScaledVector( grab.normal, - tangent.dot( grab.normal ) );

    if ( tangent.lengthSq() < 1e-4 ) return false;
    tangent.normalize();

    // The axis whose rotation moves the grabbed point along the tangent:
    // v = A x r, so A = r x t (for r perpendicular to t).
    const axis = grab.local.clone().cross( tangent );

    if ( axis.lengthSq() < 1e-6 ) return false;

    const dominant = this.dominantAxis( axis );
    const layer = this.game.controls.getLayerAtPiece( grab.piece, dominant.axis );

    if ( ! layer || layer.length === 0 ) return false;
    if ( ! this.game.controls.startHandLayer( dominant.vector, layer ) ) return false;

    grab.axis = dominant.vector;
    grab.direction = new THREE.Vector3().crossVectors( dominant.vector, grab.local ).normalize();
    grab.radius = Math.max( grab.local.length(), 0.25 );
    grab.layer = layer;
    grab.started = true;

    return true;

  }

  releaseGrab( cancel ) {

    const grab = this.grab;

    this.grab = null;
    this.hover = null;
    this.restoreMouse();

    if ( ! grab ) return;

    if ( grab.started ) {

      if ( cancel ) this.game.controls.cancelHandLayer();
      else this.game.controls.endHandLayer();

    }

    this.updateCursor( [] );

  }

  updateOrbit( metrics ) {

    const open = metrics.filter( metric => metric.open );

    if ( open.length === 0 ) {

      const now = performance.now();

      if ( ! this.orbit.lostSince ) this.orbit.lostSince = now;
      if ( now - this.orbit.lostSince < LOST_GRACE ) return;

      this.endOrbit();
      return;

    }

    this.orbit.lostSince = 0;

    const midpoint = this.midpoint( open.map( metric => this.toScreen( metric.palm ) ) );

    // Losing or gaining a hand moves the midpoint instantly. Jump the anchor
    // instead of spinning the cube by half a screen.
    if ( this.orbit.count !== open.length ) {

      this.orbit.count = open.length;
      this.orbit.last.copy( midpoint );
      return;

    }

    const dx = midpoint.x - this.orbit.last.x;
    const dy = midpoint.y - this.orbit.last.y;
    const width = this.game.world.width;
    const height = this.game.world.height;

    this.orbit.last.copy( midpoint );

    if ( Math.abs( dx ) + Math.abs( dy ) < 0.5 ) return;

    // Orbit around world axes, not camera axes: the cube then always ends up
    // on one of its 24 axis-aligned orientations after the snap, which keeps
    // the solved check (and the mouse controls) meaningful.
    const worldUp = new THREE.Vector3( 0, 1, 0 );
    const worldRight = new THREE.Vector3( 1, 0, 0 );

    if ( Math.abs( dx ) > 0 ) {

      this.game.controls.rotateHandOrbit( worldUp, dx / width * Math.PI );

    }

    if ( Math.abs( dy ) > 0 ) {

      this.game.controls.rotateHandOrbit( worldRight, dy / height * Math.PI );

    }

  }

  endOrbit() {

    this.orbit = null;
    this.hover = null;
    this.restoreMouse();

    this.game.controls.endHandOrbit();

  }

  // ---------------------------------------------------------------------
  // Landmark -> screen / cube mapping
  // ---------------------------------------------------------------------

  toScreen( landmark ) {

    // Mirror x: the preview is a mirror, and moving the hand right should
    // move the pointer right on screen.
    return new THREE.Vector2(
      ( 1 - landmark.x ) * this.game.world.width,
      landmark.y * this.game.world.height
    );

  }

  toNDC( screen ) {

    return this.pointer.set(
      ( screen.x / this.game.world.width ) * 2 - 1,
      - ( screen.y / this.game.world.height ) * 2 + 1
    );

  }

  pickCube( screen ) {

    this.raycaster.setFromCamera( this.toNDC( screen ), this.game.world.camera );

    const hits = this.raycaster.intersectObjects( this.game.cube.cubes, true );

    return hits.length > 0 ? hits[ 0 ] : null;

  }

  projectToGrabPlane( screen ) {

    this.raycaster.setFromCamera( this.toNDC( screen ), this.game.world.camera );

    const point = this.planePoint;

    if ( ! this.raycaster.ray.intersectPlane( this.grab.plane, point ) ) return null;

    return point.clone();

  }

  toCubeDirection( worldVector ) {

    const cube = this.game.cube;

    cube.object.getWorldQuaternion( this.tmpQuaternion ).inverse();
    cube.object.getWorldScale( this.tmpScale );

    return worldVector
      .clone()
      .applyQuaternion( this.tmpQuaternion )
      .divideScalar( this.tmpScale.x || 1 );

  }

  dominantAxis( vector ) {

    const axes = [
      { axis: 'x', value: vector.x },
      { axis: 'y', value: vector.y },
      { axis: 'z', value: vector.z },
    ];

    const dominant = axes.reduce( ( a, b ) => Math.abs( a.value ) >= Math.abs( b.value ) ? a : b );
    const out = new THREE.Vector3();

    out[ dominant.axis ] = Math.sign( dominant.value ) || 1;

    return { axis: dominant.axis, vector: out };

  }

  midpoint( points ) {

    const out = new THREE.Vector2();

    points.forEach( point => out.add( point ) );

    return points.length > 0 ? out.divideScalar( points.length ) : out;

  }

  distance( a, b ) {

    const dx = a.x - b.x;
    const dy = a.y - b.y;

    return Math.sqrt( dx * dx + dy * dy );

  }

  lerp( a, b, t ) {

    return {
      x: a.x + ( b.x - a.x ) * t,
      y: a.y + ( b.y - a.y ) * t,
      z: ( a.z || 0 ) + ( ( b.z || 0 ) - ( a.z || 0 ) ) * t,
    };

  }

  // ---------------------------------------------------------------------
  // Mouse hand-off and UI
  // ---------------------------------------------------------------------

  suppressMouse() {

    if ( this.mouseSuppressed ) return;

    this.mouseSuppressed = true;
    this.game.controls.draggable.disable();

  }

  restoreMouse() {

    if ( ! this.mouseSuppressed ) return;

    this.mouseSuppressed = false;

    if ( this.game.controls.enabled ) this.game.controls.draggable.enable();

  }

  loadSensitivity() {

    try {

      const stored = parseFloat( localStorage.getItem( SENSITIVITY_KEY ) );

      if ( isFinite( stored ) ) return THREE.Math.clamp( stored, SENSITIVITY_MIN, SENSITIVITY_MAX );

    } catch ( error ) {}

    return SENSITIVITY_DEFAULT;

  }

  setSensitivity( value ) {

    if ( ! isFinite( value ) ) return;

    this.sensitivity = THREE.Math.clamp( value, SENSITIVITY_MIN, SENSITIVITY_MAX );

    if ( this.dom.sensitivity ) this.dom.sensitivity.value = this.sensitivity;

    this.updateSensitivityLabel();

    try {

      localStorage.setItem( SENSITIVITY_KEY, this.sensitivity );

    } catch ( error ) {}

  }

  updateSensitivityLabel() {

    if ( this.dom.sensitivityValue ) {

      this.dom.sensitivityValue.textContent = this.sensitivity.toFixed( 2 ) + '×';

    }

  }

  updateCursor( metrics ) {

    const cursor = this.dom.cursor;
    if ( ! cursor ) return;

    const render = ( screen, grabbing, metric ) => {

      cursor.hidden = false;
      cursor.style.transform = 'translate3d(' + Math.round( screen.x ) + 'px,' + Math.round( screen.y ) + 'px,0) translate(-50%,-50%)';

      const hovering = ! grabbing && !! this.hover && !! metric && metric.id === this.hover.id;

      cursor.classList.toggle( 'is-grab', grabbing );
      cursor.classList.toggle( 'is-hover', hovering );
      cursor.classList.toggle( 'is-pinch', !! metric && metric.pinched );
      cursor.classList.toggle( 'is-open', !! metric && metric.open );

      if ( this.dom.cursorLabel ) {

        this.dom.cursorLabel.textContent = grabbing ? 'Drag to turn' : ( hovering ? 'Pinch to turn' : '' );

      }

    };

    // While a gesture runs, keep the cursor on the grabbing hand. During the
    // lost-frame grace there is no landmark, so hold the last position.
    if ( this.grab ) {

      const metric = metrics.find( item => item.id === this.grab.id );

      render( metric ? this.toScreen( metric.grabPoint ) : this.grab.screen, true, metric );
      return;

    }

    if ( metrics.length === 0 ) {

      cursor.hidden = true;
      return;

    }

    const hovered = this.hover && metrics.find( item => item.id === this.hover.id );
    const metric = hovered || metrics[ 0 ];
    const screen = hovered ? this.hover.screen : this.toScreen( metric.grabPoint );

    render( screen, false, metric );

  }

  drawPreview( hands ) {

    if ( ! this.preview || ! this.dom.overlay ) return;

    const canvas = this.dom.overlay;
    const ctx = this.preview;
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect( 0, 0, width, height );

    hands.forEach( hand => {

      const lm = hand.landmarks;
      const grabbing = this.grab && this.grab.id === hand.id;

      ctx.strokeStyle = grabbing ? 'rgba(255, 142, 66, 0.95)' : 'rgba(65, 170, 200, 0.85)';
      ctx.lineWidth = 2;

      ctx.beginPath();

      HAND_CONNECTIONS.forEach( ( [ a, b ] ) => {

        ctx.moveTo( lm[ a ].x * width, lm[ a ].y * height );
        ctx.lineTo( lm[ b ].x * width, lm[ b ].y * height );

      } );

      ctx.stroke();

      ctx.fillStyle = grabbing ? '#ff8e42' : '#41aac8';

      for ( let i = 0; i < lm.length; i++ ) {

        const radius = ( i === HAND.THUMB_TIP || i === HAND.INDEX_TIP ) ? 3.5 : 2;

        ctx.beginPath();
        ctx.arc( lm[ i ].x * width, lm[ i ].y * height, radius, 0, Math.PI * 2 );
        ctx.fill();

      }

    } );

  }

  showStatus( text, tone ) {

    if ( ! this.dom.status ) return;

    this.dom.status.textContent = text;
    this.dom.status.dataset.tone = tone || 'info';

  }

  flash( text ) {

    this.showStatus( text, 'error' );

    if ( this.dom.panel ) {

      this.dom.panel.hidden = false;
      this.dom.panel.classList.add( 'is-error' );

      clearTimeout( this.flashTimer );
      this.flashTimer = setTimeout( () => {

        if ( ! this.active ) this.dom.panel.hidden = true;

      }, 2500 );

    }

  }

}
