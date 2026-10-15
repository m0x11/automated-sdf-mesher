#!/usr/bin/env python3
"""Compare two marching-cubes STL outputs triangle-for-triangle.

    python tools/compare_stl.py A.stl[,A-part-1.stl...] B.stl[,B-part-1.stl...]

Each side is one STL or a comma-separated list of parts. Triangles are
compared as raw float32 bit patterns, ignoring order (the mesher's triangle
order depends on worker timing) and which vertex a triangle starts at, but
NOT winding. Exit 0 when the two triangle multisets are identical.
"""
import sys

import numpy as np


def load(spec: str) -> np.ndarray:
    tris = []
    for path in spec.split(","):
        with open(path, "rb") as f:
            f.seek(80)
            n = int(np.frombuffer(f.read(4), dtype="<u4")[0])
            rec = np.frombuffer(f.read(n * 50), dtype=np.dtype([
                ("normal", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")]))
        tris.append(rec["v"].reshape(n, 9).view("<u4"))
    return np.concatenate(tris) if tris else np.zeros((0, 9), "<u4")


def canonical(t: np.ndarray) -> np.ndarray:
    """Rotate each triangle so its lexicographically smallest vertex comes
    first (rotation keeps winding), then sort all triangles."""
    v = t.reshape(-1, 3, 3)

    def less(a, b):  # lexicographic a < b over xyz, vectorized
        return ((a[:, 0] < b[:, 0]) |
                ((a[:, 0] == b[:, 0]) & ((a[:, 1] < b[:, 1]) |
                                         ((a[:, 1] == b[:, 1]) & (a[:, 2] < b[:, 2])))))

    v0, v1, v2 = v[:, 0], v[:, 1], v[:, 2]
    first = np.where(less(v0, v1) & less(v0, v2) | (~less(v1, v0) & ~less(v2, v0)), 0,
                     np.where(less(v1, v2), 1, 2))
    idx = (first[:, None] + np.arange(3)[None, :]) % 3
    rot = np.take_along_axis(v, idx[:, :, None], axis=1).reshape(-1, 9)
    order = np.lexsort(rot.T[::-1])
    return rot[order]


def main() -> int:
    a, b = canonical(load(sys.argv[1])), canonical(load(sys.argv[2]))
    print(f"A: {len(a)} triangles   B: {len(b)} triangles")
    if len(a) == len(b) and np.array_equal(a, b):
        print("IDENTICAL: same triangle multiset, bit for bit")
        return 0
    # Report the size of the symmetric difference.
    av = a.view(np.dtype((np.void, 36))).ravel()
    bv = b.view(np.dtype((np.void, 36))).ravel()
    only_a = np.setdiff1d(av, bv).size
    only_b = np.setdiff1d(bv, av).size
    print(f"DIFFERENT: {only_a} triangles only in A, {only_b} only in B")
    return 1


if __name__ == "__main__":
    sys.exit(main())
