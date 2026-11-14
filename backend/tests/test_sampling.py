from app.archive import nested_sample


def test_nested_sample_is_nested_spread_and_complete():
    for total in (13, 41, 70):
        prev = set()
        for limit in sorted({min(n, total) for n in (2, 6, 12, 24, total)}):
            s = nested_sample(total, limit)
            assert len(s) == limit == len(set(s)) and s == sorted(s)
            assert s[0] == 0 and s[-1] == total - 1                     # full time baseline always covered
            assert prev <= set(s)                                         # growing N only adds frames
            gaps = [b - a for a, b in zip(s, s[1:])]
            assert max(gaps) <= 2 * (total - 1) / (limit - 1) + 1         # no gap more than ~2x the even spacing
            prev = set(s)
