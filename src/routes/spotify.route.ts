import express from 'express';
import spotifyController from '../controllers/spotify.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// PUBLIC — the OAuth callback is a top-level browser redirect with no auth
// header; trust comes from the HMAC-signed `state`. Declared BEFORE crmAuth().
router.get('/callback', spotifyController.callback);

// Everything below requires a CRM session.
router.use(crmAuth());

router.get('/auth-url', spotifyController.getAuthUrl);
router.get('/status', spotifyController.status);
router.post('/disconnect', spotifyController.disconnect);
router.get('/token', spotifyController.getToken);

// Browse
router.get('/me', spotifyController.me);
router.get('/playlists', spotifyController.playlists);
router.get('/recently-played', spotifyController.recentlyPlayed);
router.get('/top-tracks', spotifyController.topTracks);
router.get('/saved-tracks', spotifyController.savedTracks);
router.get('/player', spotifyController.player);
router.get('/devices', spotifyController.devices);

// Playback controls
router.put('/player/play', spotifyController.controlPlay);
router.put('/player/pause', spotifyController.controlPause);
router.post('/player/next', spotifyController.controlNext);
router.post('/player/previous', spotifyController.controlPrevious);
router.put('/player/seek', spotifyController.controlSeek);
router.put('/player/volume', spotifyController.controlVolume);
router.put('/player/shuffle', spotifyController.controlShuffle);
router.put('/player/repeat', spotifyController.controlRepeat);
router.put('/player/transfer', spotifyController.transfer);

export default router;