export class PeerState {
  constructor(peerId, localId, polite) {
    this.peerId          = peerId
    this.polite          = polite
    this.pc              = null
    this.makingOffer     = false
    this.ignoreOffer     = false
    this.pendingCandidates = []
    this.remoteDescSet   = false
    this.needsNegotiation = false
    this.needsIceRestart  = false
    this._peerJoinEmitted = false
    this._joinResyncDone = false
    this._negotiating = false
    this._negotiateQueued = false
  }
}
