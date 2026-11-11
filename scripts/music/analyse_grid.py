"""Step 2b: on each normalised file (out/<id>.m4a): the beat grid (bpm, first beat) with a half-split check, and the
sections a cut can land on (the drop: the biggest rise in level; the peak: the loudest 8 s) -> grid.json."""
import json, os, subprocess
import numpy as np, librosa
from concurrent.futures import ProcessPoolExecutor

SR = 22050


def fit(beats):
    """Least-squares grid through beat times: (period, phase)."""
    k = np.arange(len(beats))
    p, b = np.polyfit(k, beats, 1)
    return p, b


def grid_of(rid):
    w = f'wav/{rid}.wav'
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', f'out/{rid}.m4a', '-ac', '1', '-ar', str(SR), w])
    y, sr = librosa.load(w, sr=SR, mono=True)
    os.remove(w)
    _, bt = librosa.beat.beat_track(y=y, sr=sr, units='time')
    out = dict(id=rid, bpm=None, firstBeatSec=None, gridAgrees=False)
    if len(bt) >= 16:
        p, b = fit(bt)
        bpm = 60 / p
        first = b % p
        h = len(bt) // 2
        p1, b1 = fit(bt[:h]); p2, b2 = fit(bt[h:])
        ph1 = b1 % p1; ph2 = (b2 + h * p2) % p2  # second half's phase, on the same index origin
        dphase = min(abs(ph1 - ph2), p - abs(ph1 - ph2))
        agrees = abs(60 / p1 - 60 / p2) <= 0.5 and dphase <= 0.03
        out.update(bpm=round(float(bpm), 2), firstBeatSec=round(float(first), 3), gridAgrees=bool(agrees),
                   halfBpm=[round(float(60 / p1), 2), round(float(60 / p2), 2)], phaseDiffMs=round(float(dphase) * 1000, 1))
    # sections
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    win = int(2.0 * sr / hop)
    db = 20 * np.log10(np.convolve(rms, np.ones(win) / win, mode='same') + 1e-9)
    start = int(3.0 * sr / hop)
    rise = db[win:] - db[:-win]
    rise[: max(0, start - win)] = -np.inf
    i = int(np.argmax(rise)) + win if len(rise) else 0
    drop = float(t[min(i, len(t) - 1)]) if len(rise) and rise.max() >= 6 else None
    w8 = int(8.0 * sr / hop)
    loud = np.convolve(rms ** 2, np.ones(w8), mode='valid')
    peak = float(t[int(np.argmax(loud))]) if len(loud) else 0.0
    out.update(dropSec=round(drop, 2) if drop is not None else None, peakSec=round(peak, 2))
    return out


if __name__ == '__main__':
    ids = [r['id'] for r in json.load(open('library.manifest.json', encoding='utf-8'))]
    os.makedirs('wav', exist_ok=True)
    with ProcessPoolExecutor(4) as ex:
        res = list(ex.map(grid_of, ids))
    json.dump(res, open('grid.json', 'w'), indent=1)
    print(len(res), 'agree', sum(r['gridAgrees'] for r in res), 'drops', sum(r['dropSec'] is not None for r in res))
