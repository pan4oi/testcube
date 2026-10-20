// Webcam + MediaPipe Hand Landmarker.
//
// This is the only file that talks to the camera or to MediaPipe. It exposes
// a small stream of hands to the rest of the app:
//
//   [ { id, landmarks, worldLandmarks, handedness, score } ]
//
// `landmarks` are the 21 MediaPipe points in image-normalized coordinates
// (0..1), already smoothed. Consumers only need the image landmarks; the world
// landmarks are passed through for completeness.
//
// The MediaPipe runtime is vendored in vendor/mediapipe, so no CDN is needed.
// Camera access still requires a secure context: https:// or http://localhost.
// Browsers refuse getUserMedia on file://, which start() reports as a normal
// (non-fatal) error instead of failing silently.

class HandTrackerError extends Error {

  constructor( code, message ) {

    super( message );

    this.name = 'HandTrackerError';
    this.code = code;

  }

}

class HandTracker {

  constructor( options = {} ) {

    this.video = options.video;
    this.basePath = options.basePath || './vendor/mediapipe';

    this.numHands = options.numHands || 2;
    this.minInterval = options.minInterval || ( 1000 / 30 );

    this.onHands = () => {};
    this.onStatus = () => {};

    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.startPromise = null;
    this.frames = 0;
    this.error = null;

    this.lastVideoTime = -1;
    this.lastDetectTime = 0;

    // One-pole low-pass filter per hand and landmark. MediaPipe is accurate
    // but twitchy; without this the cube visibly shakes in the hand.
    this.smooth = {};
    this.smoothAlpha = 0.55;

    this.loop = this.loop.bind( this );

  }

  start() {

    if ( this.running ) return Promise.resolve();

    // Share one in-flight start instead of opening a second camera stream if
    // the toggle is pressed twice.
    if ( this.startPromise ) return this.startPromise;

    this.startPromise = this.startup().finally( () => { this.startPromise = null; } );

    return this.startPromise;

  }

  async startup() {

    if ( location.protocol === 'file:' ) {

      throw new HandTrackerError(
        'insecure-origin',
        'Camera access is blocked on file:// pages. Run the game from a local server (for example `python3 -m http.server`) and open http://localhost:8000.'
      );

    }

    if ( ! navigator.mediaDevices || ! navigator.mediaDevices.getUserMedia ) {

      throw new HandTrackerError(
        'unsupported',
        'This browser does not expose a camera API. Try a recent Chrome, Edge, Safari or Firefox over https:// or localhost.'
      );

    }

    if ( ! window.Vision || ! window.Vision.HandLandmarker ) {

      throw new HandTrackerError(
        'missing-runtime',
        'The MediaPipe runtime did not load. Check that vendor/mediapipe/vision_bundle.js is present.'
      );

    }

    this.error = null;
    this.onStatus( 'camera' );

    try {

      this.stream = await navigator.mediaDevices.getUserMedia( {
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      } );

    } catch ( error ) {

      throw this.describeCameraError( error );

    }

    this.video.srcObject = this.stream;
    this.video.muted = true;

    try {

      await this.video.play();

    } catch ( error ) {

      // play() rejects if the element is detached or the track ends early.
      this.stop();

      throw new HandTrackerError( 'camera-failed', 'The camera stream could not be started: ' + error.message );

    }

    this.onStatus( 'model' );

    const base = new URL( this.basePath, location.href ).href;

    try {

      const vision = await window.Vision.FilesetResolver.forVisionTasks( base + '/wasm' );

      const options = {
        baseOptions: {
          modelAssetPath: base + '/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: this.numHands,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      };

      try {

        this.landmarker = await window.Vision.HandLandmarker.createFromOptions( vision, options );

      } catch ( error ) {

        // SwiftShader / blocklisted GPUs reject the GPU delegate. CPU is
        // slower but keeps the feature usable.
        options.baseOptions.delegate = 'CPU';
        this.landmarker = await window.Vision.HandLandmarker.createFromOptions( vision, options );

      }

    } catch ( error ) {

      this.stop();

      throw new HandTrackerError( 'model-failed', 'The hand model could not be loaded: ' + error.message );

    }

    this.frames = 0;
    this.lastVideoTime = -1;
    this.lastDetectTime = 0;

    this.running = true;
    this.onStatus( 'running' );

    requestAnimationFrame( this.loop );

  }

  stop() {

    this.running = false;
    this.lastVideoTime = -1;
    this.frames = 0;
    this.smooth = {};

    if ( this.stream ) {

      this.stream.getTracks().forEach( track => track.stop() );
      this.stream = null;

    }

    if ( this.video ) {

      this.video.pause();
      this.video.srcObject = null;

    }

    if ( this.landmarker ) {

      try {

        this.landmarker.close();

      } catch ( error ) {}

      this.landmarker = null;

    }

    this.onHands( [] );

  }

  loop() {

    if ( ! this.running ) return;

    requestAnimationFrame( this.loop );

    if ( ! this.video || this.video.readyState < 2 ) return;

    // A 30 fps camera at 60 fps display: detect only on new frames, and no
    // more often than minInterval. rAF still runs so the UI stays smooth.
    if ( this.video.currentTime === this.lastVideoTime ) return;

    const now = performance.now();
    if ( now - this.lastDetectTime < this.minInterval ) return;

    this.lastDetectTime = now;
    this.lastVideoTime = this.video.currentTime;

    let result;

    try {

      result = this.landmarker.detectForVideo( this.video, this.lastVideoTime * 1000 );

    } catch ( error ) {

      this.error = error;
      this.onStatus( 'error', error );
      this.stop();

      return;

    }

    this.frames++;

    this.onHands( this.format( result ) );

  }

  format( result ) {

    const hands = [];
    const seen = {};

    if ( ! result || ! result.landmarks ) return hands;

    result.landmarks.forEach( ( landmarks, index ) => {

      const category = ( result.handedness && result.handedness[ index ] && result.handedness[ index ][ 0 ] ) || null;
      const label = category ? category.categoryName : 'Hand';
      const key = label + '-' + index;

      seen[ key ] = true;

      if ( ! this.smooth[ key ] ) this.smooth[ key ] = landmarks.map( point => ( { x: point.x, y: point.y, z: point.z } ) );

      const smoothed = landmarks.map( ( point, i ) => {

        const previous = this.smooth[ key ][ i ] || point;
        const a = this.smoothAlpha;

        const next = {
          x: previous.x + ( point.x - previous.x ) * a,
          y: previous.y + ( point.y - previous.y ) * a,
          z: previous.z + ( point.z - previous.z ) * a,
        };

        this.smooth[ key ][ i ] = next;

        return next;

      } );

      hands.push( {
        id: key,
        landmarks: smoothed,
        worldLandmarks: result.worldLandmarks ? result.worldLandmarks[ index ] : null,
        handedness: label,
        score: category ? category.score : 1,
      } );

    } );

    // Drop filter state for hands that left the frame, so one re-entering is
    // not pulled toward a stale position.
    Object.keys( this.smooth ).forEach( key => {

      if ( ! seen[ key ] ) delete this.smooth[ key ];

    } );

    return hands;

  }

  describeCameraError( error ) {

    if ( error && error.name === 'NotAllowedError' ) {

      return new HandTrackerError(
        'permission-denied',
        'Camera permission was denied. Allow camera access in the address bar, then enable Realistic Mode again.'
      );

    }

    if ( error && error.name === 'NotFoundError' ) {

      return new HandTrackerError( 'no-camera', 'No camera was found. Connect a webcam and try again.' );

    }

    if ( error && error.name === 'NotReadableError' ) {

      return new HandTrackerError( 'camera-busy', 'The camera is in use by another app. Close it and try again.' );

    }

    return new HandTrackerError( 'camera-failed', 'The camera could not be started: ' + ( error ? error.message : 'unknown error' ) );

  }

}
