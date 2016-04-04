
import React from 'react';
import {connect} from 'react-redux';
import {Button} from 'react-bootstrap';
import EpicComponent from 'epic-component';

import Terminal from '../terminal';
import actions from '../actions';
import {recordEventAction} from '../recorder';
import RecordingControls from './controls';
import Editor  from './editor';
import EventView from './event_view'

export const RecordingScreen = EpicComponent(self => {

  const onSourceSelect = function (selection) {
    self.props.dispatch({type: actions.recordingScreenSourceSelectionChanged, selection});
    self.props.dispatch(recordEventAction(['select', selection]));
  };

  const onSourceEdit = function (edit) {
    const {start, end} = edit;
    const range = {start, end};
    if (edit.action === 'insert') {
      self.props.dispatch(recordEventAction(['insert', range, edit.lines]));
    } else {
      self.props.dispatch(recordEventAction(['delete', range]));
    }
  };

  const onSourceChange = function (source) {
    self.props.dispatch({type: actions.recordingScreenSourceTextChanged, source});
  };

  const renderStack = function (state, scope) {
    const elems = [];
    while (scope) {
      switch (scope.kind) {
        case 'function':
          elems.push(
            <div key={scope.key}>
              <span>{"function "}{scope.block[1].name}</span>
            </div>
          );
          break;
        case 'block':
          elems.push(
            <div key={scope.key}>
              <span>{"block"}</span>
            </div>
          );
          break;
        case 'vardecl':
          elems.push(
            <div key={scope.key}>
              <span>{"var "}</span>
              <span>{scope.decl.name}</span>
              {' = '}
              <span>JSON.stringify({deref(state, scope.decl.ref, scope.decl.ty)})</span>
            </div>
          );
          break;
        case 'param':
          elems.push(
            <div key={scope.key}>
              <span>{"var "}</span>
              <span>{scope.decl.name}</span>
              {' = '}
              <span>{JSON.stringify(deref(state, scope.decl.ref, scope.decl.ty))}</span>
            </div>
          );
          break;
      }
      scope = scope.parent;
    }
    return elems;
  };

  const recordingPanel = function () {
    return (
      <div className="row">
        <div className="col-md-12">
          <p>Liste des segments, bouton sur le dernier pour le supprimer,
             bouton sur chaque segment pour le lire.</p>
        </div>
      </div>);
  };

  const onTranslate = function () {
    const {source} = self.props;
    self.props.dispatch({
      type: actions.translateSource,
      language: 'c',
      source: source
    });
  };

  self.render = function () {
    const {recorder} = self.props;
    if (!recorder) {
      return <p>Recorder is not initialized.</p>;
    }
    if (recorder.state === 'preparing') {
      return <p>Preparing recorder: {recorder.progress}.</p>;
    }
    const isRecording = recorder.state === 'recording';
    const {events, elapsed} = recorder;
    const {dispatch, source, selection, isTranslated, stepperState} = self.props;
    const {control, terminal, error, scope} = (stepperState || {});
    const haveNode = control && control.node;
    return (
      <div>
        <div className="row">
          <div className="col-md-12">
            <RecordingControls dispatch={dispatch} isRecording={isRecording} isTranslated={isTranslated} haveNode={haveNode} elapsed={elapsed} eventCount={events.count()} onTranslate={onTranslate} />
            {error && <p>{error}</p>}
          </div>
        </div>
        {!isRecording && recordingPanel()}
        <div className="row">
          <div className="col-md-6">
            <div className="pane pane-source">
              <h2>Source C</h2>
              <Editor name="input_code" value={source} selection={selection} onChange={onSourceChange} onEdit={onSourceEdit} onSelect={onSourceSelect} readOnly={isTranslated} width='100%' height='336px'/>
            </div>
          </div>
          {terminal && <div className="col-md-6">
            <h2>Terminal</h2>
            <Terminal terminal={terminal}/>
          </div>}
        </div>
        <div className="row">
          <div className="col-md-12">
            <div className="dev-EventsPanel">
              {events.slice(0, 10).map(event => <EventView event={event}/>)}
            </div>
          </div>
        </div>
      </div>
    );
  };

});

function recordingScreenSelector (state, props) {
  const {recordingScreen, translated, recorder} = state;
  const {source, selection, stepperState} = recordingScreen;
  return {
    source, selection,
    stepperState,
    recorder,
    isTranslated: !!translated
  };
};

export default connect(recordingScreenSelector)(RecordingScreen);
