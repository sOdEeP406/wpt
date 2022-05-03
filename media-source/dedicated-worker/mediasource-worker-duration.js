importScripts("mediasource-worker-util.js");

// Note, we do not use testharness.js utilities within the worker context
// because it also communicates using postMessage to the main HTML document's
// harness, and would confuse the test case message parsing there.

let util = new MediaSourceWorkerUtil();
let sourceBuffer;

// Phases of this test case, in sequence:
const testPhase = {
  // Main thread verifies initial unattached HTMLMediaElement duration is NaN
  // and readyState is HAVE_NOTHING, then starts this worker.
  // This worker creates a MediaSource, verifies its initial duration
  // is NaN, creates an object URL for the MediaSource and sends the URL to the
  // main thread.
  kInitial: "Initial",
  // Main thread receives object URL, re-verifies that the media element
  // duration is still NaN and readyState is still HAVE_NOTHING, and then sets
  // the URL as the src of the media element, eventually causing worker
  // mediaSource 'onsourceopen' event dispatch.
  kAttaching: "Attaching",
  kVerifyPostAttachDuration: "Verifying post-attachment duration",
  kVerifyPostAttachHaveNothing: "Verifying post-attachment readyState is HAVE_NOTHING",
  kVerifyPostAttachExplicitlySetDuration: "Verifying post-attachment explicitly set duration",
  kVerifyPostAttachStillHaveNothing: "Verifying post-attachment readyState is still HAVE_NOTHING",
  kAwaitingNewDurationDueToBuffering: "Awaiting updated duration due to buffering media",
  kVerifyAtLeastHaveMetadata: "Confirming at least HAVE_METADATA ",
};

const processingReason = {
  kTopOfPhase: "First part of processing for the current phase, typically involves sending a message",
  kDueToVerificationAck: "Tail processing of current phase following verification ACK receipt",
};

let phase = testPhase.kInitial;

// Setup handler for receipt of attachment completion.
util.mediaSource.addEventListener("sourceopen", () => {
  URL.revokeObjectURL(util.mediaSourceObjectUrl);
  if (phase !== testPhase.kAttaching) {
    postMessage({
      subject: messageSubject.ERROR,
      info: "Unexpected sourceopen received by Worker mediaSource during test phase: " + phase
    });
    return;
  }

  phase = testPhase.kVerifyPostAttachDuration;
  processPhase();
}, { once : true });

// Setup handler for receipt of acknowledgement of successful verifications from
// main thread. |ackVerificationData| contains the round-tripped verification
// request that the main thread just sent, and is used in processPhase to ensure
// the ACK for this phase matched the request for verification.
let ackVerificationData;
onmessage = e => {
  if (e.data === undefined || e.data.subject !== messageSubject.ACK_VERIFIED || e.data.info === undefined) {
    postMessage({
      subject: messageSubject.ERROR,
      info: "Invalid message received by Worker"
    });
    return;
  }

  ackVerificationData = e.data.info;
  processPhase(processingReason.kDueToVerificationAck);
};

processPhase();


// Returns true if checks succeed, false otherwise.
function checkAckVerificationData(expectedRequest) {

  // Compares only subject and info fields. Uses logic similar to testharness.js's
  // same_value(x,y) to correctly handle NaN, but doesn't distinguish +0 from -0.
  function messageValuesEqual(m1, m2) {
    if (m1.subject !== m1.subject) {
      // NaN case
      if (m2.subject === m2.subject)
        return false;
    } else if (m1.subject !== m2.subject) {
      return false;
    }

    if (m1.info !== m1.info) {
      // NaN case
      return (m2.info !== m2.info);
    }

    return m1.info === m2.info;
  }

  if (messageValuesEqual(expectedRequest, ackVerificationData)) {
    ackVerificationData = undefined;
    return true;
  }

  postMessage({
    subject: messageSubject.ERROR,
    info: "ACK_VERIFIED message from main thread was for a mismatching request for this phase. phase=[" + phase +
          "], expected request that would produce ACK in this phase=[" + JSON.stringify(expectedRequest) +
          "], actual request reported with the ACK=[" + JSON.stringify(ackVerificationData) + "]"
  });

  ackVerificationData = undefined;
  return false;
}

function bufferMediaAndSendDurationVerificationRequest() {
  sourceBuffer = util.mediaSource.addSourceBuffer(util.mediaMetadata.type);
  sourceBuffer.onerror = (err) => {
    postMessage({ subject: messageSubject.ERROR, info: err });
  };
  sourceBuffer.onupdateend = () => {
    // Sanity check the duration.
    // Unnecessary for this buffering, except helps with test coverage.
    var duration = util.mediaSource.duration;
    if (isNaN(duration) || duration <= 0.0) {
      postMessage({
        subject: messageSubject.ERROR,
        info: "mediaSource.duration " + duration + " is not within expected range (0,1)"
      });
      return;
    }

    // Await the main thread media element duration matching the worker
    // mediaSource duration.
    postMessage(getAwaitCurrentDurationRequest());
  };

  util.mediaLoadPromise.then(mediaData => { sourceBuffer.appendBuffer(mediaData); },
                             err => { postMessage({ subject: messageSubject.ERROR, info: err }) });
}


function getAwaitCurrentDurationRequest() {
  // Sanity check that we have a numeric duration value now.
  const dur = util.mediaSource.duration;
  if (Number.isNaN(dur)) {
    postMessage({
        subject: messageSubject.ERROR,
        info: "Unexpected NaN duration in worker: " + phase
    });
  }

  return { subject: messageSubject.AWAIT_DURATION, info: dur };
}

function processPhase(reason = processingReason.kTopOfPhase) {
  if (reason !== processingReason.kTopOfPhase && reason !== processingReason.kDueToVerificationAck) {
    postMessage({
      subject: messageSubject.ERROR,
      info: "invalid processingReason: " + reason
    });
    return;
  }

  if (reason === processingReason.kDueToVerificationAck &&
      (phase === testPhase.kInitial || phase === testPhase.kAttaching)) {
    postMessage({
      subject: messageSubject.ERROR,
      info: "Current test phase [" + phase + "] does not expect verification ack receipt from main thread"
    });
    return;
  }

  switch (phase) {

    case testPhase.kInitial:
      if (!Number.isNaN(util.mediaSource.duration)) {
        postMessage({
          subject: messageSubject.ERROR,
          info: "Initial unattached MediaSource duration must be NaN"
        });
        break;
      }

      phase = testPhase.kAttaching;
      postMessage({ subject: messageSubject.OBJECT_URL, info: util.mediaSourceObjectUrl });
      break;

    case testPhase.kAttaching:
      postMessage({
        subject: messageSubject.ERROR,
        info: "kAttaching phase is handled by main thread and by worker onsourceopen, not this switch case."
      });
      break;

    case testPhase.kVerifyPostAttachDuration:
      const postAttachDurationVerificationRequest = { subject: messageSubject.VERIFY_DURATION, info: NaN };
      if (reason === processingReason.kTopOfPhase) {
        // Request verification
        postMessage(postAttachDurationVerificationRequest);
        break;
      }

      // Go to next phase if verification ack matches this phase's earlier request for verification.
      if (checkAckVerificationData(postAttachDurationVerificationRequest)) {
        phase = testPhase.kVerifyPostAttachHaveNothing;
        processPhase();
      }
      break;

    case testPhase.kVerifyPostAttachHaveNothing:
      const postAttachHaveNothingVerificationRequest = { subject: messageSubject.VERIFY_HAVE_NOTHING };
      if (reason === processingReason.kTopOfPhase) {
        // Request verification
        postMessage(postAttachHaveNothingVerificationRequest);
        break;
      }

      // Go to next phase if verification ack matches this phase's earlier request for verification
      if (checkAckVerificationData(postAttachHaveNothingVerificationRequest)) {
        phase = testPhase.kVerifyPostAttachExplicitlySetDuration;
        processPhase();
      }
      break;

    case testPhase.kVerifyPostAttachExplicitlySetDuration:
      const newDuration = 0.1;
      const postAttachExplicitlySetDurationVerificationRequest = { subject: messageSubject.AWAIT_DURATION, info: newDuration };
      if (reason === processingReason.kTopOfPhase) {
        // Set the duration, then request verification.
        util.mediaSource.duration = newDuration;
        postMessage(postAttachExplicitlySetDurationVerificationRequest);
        break;
      }

      // Go to next phase if main thread reported the media element duration updated correctly, eventually.
      if (checkAckVerificationData(postAttachExplicitlySetDurationVerificationRequest)) {
        phase = testPhase.kVerifyPostAttachStillHaveNothing;
        processPhase();
      }
      break;

    case testPhase.kVerifyPostAttachStillHaveNothing:
      const postAttachStillHaveNothingVerificationRequest = { subject: messageSubject.VERIFY_HAVE_NOTHING };
      if (reason === processingReason.kTopOfPhase) {
        postMessage(postAttachStillHaveNothingVerificationRequest);
        break;
      }

      if (checkAckVerificationData(postAttachStillHaveNothingVerificationRequest)) {
        phase = testPhase.kAwaitingNewDurationDueToBuffering;
        processPhase();
      }
      break;

    case testPhase.kAwaitingNewDurationDueToBuffering:
      if (reason === processingReason.kTopOfPhase) {
        bufferMediaAndSendDurationVerificationRequest();
        break;
      }

      if (checkAckVerificationData(getAwaitCurrentDurationRequest())) {
        phase = testPhase.kVerifyAtLeastHaveMetadata;
        processPhase();
      }
      break;

    case testPhase.kVerifyAtLeastHaveMetadata:
      const verifyAtLeastHaveMetadataRequest = { subject: messageSubject.VERIFY_AT_LEAST_HAVE_METADATA };
      if (reason === processingReason.kTopOfPhase) {
        postMessage(verifyAtLeastHaveMetadataRequest);
        break;
      }

      if (checkAckVerificationData(verifyAtLeastHaveMetadataRequest)) {
        postMessage({ subject: messageSubject.WORKER_DONE });
      }
      break;

    default:
      postMessage({
        subject: messageSubject.ERROR,
        info: "Unexpected test phase in worker:" + phase,
      });
  }

}
