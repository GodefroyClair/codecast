
// An instant has shape {t, eventIndex, state},
// where state is an Immutable Map of shape {source, input, syntaxTree, stepper, stepperInitial}
// where source and input are buffer models (of shape {document, selection, firstVisibleRow}).

import {buffers, eventChannel, END} from 'redux-saga';
import {takeLatest, take, put, call, race, fork, select, cancelled} from 'redux-saga/effects';
import * as C from 'persistent-c';
import Immutable from 'immutable';

import {getJson} from '../common/utils';
import {RECORDING_FORMAT_VERSION} from '../version';
import {findInstantIndex} from './utils';

export default function (bundle, deps) {

  bundle.use(
    'replayApi',
    'playerPrepare', 'playerPreparing', 'playerReady',
    'playerPrepareProgress', 'playerPrepareFailure',
    'playerStart', 'playerStarted',
    'playerPause', 'playerPaused',
    'playerSeek', 'playerTick',
    'getPlayerState',
    'stepperStep', 'stepperEnabled', 'stepperDisabled',
  );

  //
  // Sagas (generators)
  //

  bundle.addSaga(function* playerSaga () {
    yield takeLatest(deps.playerPrepare, playerPrepare);
    /* Use redux-saga takeLatest to cancel any executing replay saga. */
    const anyReplayAction = [deps.playerStart, deps.playerPause, deps.playerSeek];
    yield takeLatest(anyReplayAction, replaySaga);
  });

  function* playerPrepare ({payload}) {
    /*
      baseDataUrl is forwarded to playerReady (stored in its reducer) in order
        to serve as the base URL for subtitle files (in the player & editor).
      audioUrl, eventsUrl need to be able to be passed independently by the
        recorder, where they are "blob:" URLs.
    */
    const {baseDataUrl, audioUrl, eventsUrl} = payload;
    // Check that the player is idle.
    const player = yield select(deps.getPlayerState);
    if (player.get('isPlaying')) {
      return;
    }
    // Emit a Preparing action.
    yield put({type: deps.playerPreparing});
    /* Load the audio. */
    const audio = player.get('audio');
    audio.src = audioUrl;
    audio.load();
    /* Load the events. */
    let data = yield call(getJson, eventsUrl);
    if (Array.isArray(data)) {
      yield put({type: deps.playerPrepareFailure, payload: {message: "recording is incompatible with this player"}});
      return;
    }
    /* Compute the future state after every event. */
    const chan = yield call(requestAnimationFrames, 50);
    const replayContext = {
      state: Immutable.Map(),
      events: data.events,
      instants: [],
      addSaga,
      reportProgress,
    };
    try {
      yield call(computeInstants, replayContext);
      /* The duration of the recording is the timestamp of the last event. */
      const instants = replayContext.instants;
      const duration = instants[instants.length - 1].t;
      yield put({type: deps.playerReady, payload: {baseDataUrl, duration, data, instants}});
      yield call(resetToAudioTime, 0);
    } catch (ex) {
      yield put({type: deps.playerPrepareFailure, payload: {message: `${ex.toString()}`, context: replayContext}});
      return null;
    } finally {
      chan.close();
    }
    function addSaga (saga) {
      let {sagas} = replayContext.instant;
      if (!sagas) {
        sagas = replayContext.instant.sagas = [];
      }
      sagas.push(saga);
    }
    function* reportProgress (progress) {
      yield put({type: deps.playerPrepareProgress, payload: {progress}});
      /* Allow the display to refresh. */
      yield take(chan);
    }
  }

  function* computeInstants (replayContext) {
    /* CONSIDER: create a redux store, use the replayApi to convert each event
       to an action that is dispatched to the store (which must have an
       appropriate reducer) plus an optional saga to be called during playback. */
    let pos, progress, lastProgress = 0, range;
    const events = replayContext.events;
    const duration = events[events.length - 1][0];
    for (pos = 0; pos < events.length; pos += 1) {
      const event = events[pos];
      const t = event[0];
      const key = event[1]
      const instant = {t, pos, event};
      replayContext.instant = instant;
      yield call(deps.replayApi.applyEvent, key, replayContext, event);
      /* Preserve the last explicitly set range. */
      if ('range' in instant) {
        range = instant.range;
      } else {
        instant.range = range;
      }
      instant.state = replayContext.state;
      replayContext.instants.push(instant);
      progress = Math.round(pos * 50 / events.length + t * 50 / duration) / 100;
      if (progress !== lastProgress) {
        lastProgress = progress;
        yield call(replayContext.reportProgress, progress);
      }
    }
  }

  function* replaySaga ({type, payload}) {
    const player = yield select(deps.getPlayerState);
    const isPlaying = player.get('isPlaying');
    const audio = player.get('audio');
    const instants = player.get('instants');
    let audioTime = player.get('audioTime');
    let instant = player.get('current');

    if (type === deps.playerStart && !player.get('isReady')) {
      /* Prevent starting playback until ready.  Should perhaps wait until
         preparation is done, for autoplay. */
      return;
    }
    if (type === deps.playerStart) {
      /* If at end of stream, restart automatically. */
      if (instant.isEnd) {
        audioTime = 0;
        audio.currentTime = 0;
      }
      /* The player was started (or resumed), reset to the current instant to
         clear any possible changes to the state prior to entering the update
         loop. */
      yield call(resetToAudioTime, audioTime);
      /* Disable the stepper during playback, its states are pre-computed. */
      yield put({type: deps.stepperDisabled});
      /* Play the audio now that an accurate state is displayed. */
      audio.play();
      yield put({type: deps.playerStarted});
    }

    if (type === deps.playerPause) {
      /* The player is being paused.  The audio is paused first, then the
         audio time is used to reset the state accurately. */
      audio.pause();
      const audioTime = Math.round(audio.currentTime * 1000);
      yield call(resetToAudioTime, audioTime);
      yield call(restartStepper);
      yield put({type: deps.playerPaused});
      return;
    }

    if (type === deps.playerSeek) {
      if (!isPlaying) {
        /* The stepper is disabled before a seek-while-paused, as it could be
           waiting on I/O. */
        yield put({type: deps.stepperDisabled});
      }
      /* Refreshing the display first then make the jump in the audio should
         make a cleaner jump, as audio will not start playing at the new
         position until the new state has been rendered. */
      const audioTime = Math.max(0, Math.min(player.get('duration'), payload.audioTime));
      yield call(resetToAudioTime, audioTime);
      if (!isPlaying) {
        /* The stepper is restarted after a seek-while-paused, in case it is
           waiting on I/O. */
        yield call(restartStepper);
      }
      audio.currentTime = audioTime / 1000;
      if (!isPlaying) {
        return;
      }
      /* fall-through for seek-during-playback, which is handled by the
         periodic update loop */
    }

    /* The periodic update loop runs until cancelled by another replay action. */
    const chan = yield call(requestAnimationFrames, 50);
    try {
      while (!(yield select(state => state.getIn(['player', 'current']).isEnd))) {
        /* Use the audio time as reference. */
        let endTime = Math.round(audio.currentTime * 1000);
        if (audio.ended) {
          /* Extend a short audio to the timestamp of the last event. */
          endTime = instants[instants.length - 1].t;
        }
        if (endTime < audioTime || audioTime + 100 < endTime) {
          /* Audio time has jumped. */
          yield call(resetToAudioTime, endTime);
        } else {
          /* Continuous playback. */
          yield call(replayToAudioTime, instants, audioTime, endTime);
        }
        audioTime = endTime;
        yield take(chan);
      }
    } finally {
      chan.close();
    }

    /* Pause when the end event is reached. */
    yield put({type: deps.playerPause});
  }

  function* replayToAudioTime (instants, startTime, endTime) {
    let instantIndex = findInstantIndex(instants, startTime);
    const nextInstantIndex = findInstantIndex(instants, endTime);
    if (instantIndex === nextInstantIndex) {
      /* Fast path: audio time has advanced but we are still at the same
         instant, just emit a tick event to update the audio time. */
      yield put({type: deps.playerTick, payload: {audioTime: endTime}});
      return;
    }
    /* Update the DOM by replaying incremental events between (immediately
       after) `instant` and up to (including) `nextInstant`. */
    instantIndex += 1;
    while (instantIndex <= nextInstantIndex) {
      let instant = instants[instantIndex];
      if (typeof instant.jump === 'number') {
        yield call(jumpToAudioTime, instant.jump);
      }
      if (instant.sagas) {
        /* Keep in mind that the instant's saga runs *prior* to the call
           to resetToAudioTime below, and should not rely on the global
           state being accurate.  Instead, it should use `instant.state`. */
        for (let saga of instant.sagas) {
          yield call(saga, instant);
        }
      }
      if (instant.isEnd) {
        /* Stop a long audio at the timestamp of the last event. */
        endTime = instant.t;
        break;
      }
      instantIndex += 1;
    }
    /* Perform a quick reset to update the editor models without pushing
       the new state to the editors instances (they are assumed to have
       been synchronized by replaying individual events).
    */
    yield call(resetToAudioTime, endTime, true);
  }

  /* A quick reset avoids disabling and re-enabling the stepper (which restarts
     the stepper task). */
  function* resetToAudioTime (audioTime, quick) {
    /* Call playerTick to store the current audio time and to install the
       current instant's state as state.getIn(['player', 'current']). */
    yield put({type: deps.playerTick, payload: {audioTime}});
    /* Call the registered reset-sagas to update any part of the state not
       handled by playerTick. */
    const instant = yield select(state => state.getIn(['player', 'current']));
    yield call(deps.replayApi.reset, instant, quick);
  }

  function* restartStepper () {
    /* Re-enable the stepper to allow the user to interact with it. */
    yield put({type: deps.stepperEnabled});
    /* If the stepper was running and blocking on input, do a "step-into" to
       restore the blocked-on-I/O state. */
    const instant = yield select(state => state.getIn(['player', 'current']));
    if (instant.state.get('status') === 'running') {
      const {isWaitingOnInput} = instant.state.get('current');
      if (isWaitingOnInput) {
        yield put({type: deps.stepperStep, mode: 'into'});
      }
    }
  }

  function* jumpToAudioTime (audioTime) {
    /* Jump and full reset to the specified audioTime. */
    const player = yield select(deps.getPlayerState);
    const audio = player.get('audio');
    audio.currentTime = audioTime / 1000;
    yield call(resetToAudioTime, audioTime);
  }

};

function requestAnimationFrames (maxDelta) {
  let shutdown = false;
  let lastTimestamp = 0;
  return eventChannel(function (emitter) {
    function onAnimationFrame (timestamp) {
      if (timestamp >= lastTimestamp + maxDelta) {
        lastTimestamp = timestamp;
        emitter(timestamp);
      }
      if (!shutdown) {
        window.requestAnimationFrame(onAnimationFrame);
      }
    }
    window.requestAnimationFrame(onAnimationFrame);
    return function () {
      shutdown = true;
    };
  }, buffers.sliding(1));
}

class Modernizer {
  constructor (events) {
    this._events = events;
  }
  toObject () {
    const {version, source, input, ...init} = this._events[0][2];
    if (source || input) {
      init.buffers = {source, input};
    }
    if (!init.ioPaneMode) {
      init.ioPaneMode = 'split';
    }
    return {
      version,
      events: Array.from({[Symbol.iterator]: () => new ModernizerIterator(init, this._events.slice(1))}),
      subtitles: false
    };
  }
}
