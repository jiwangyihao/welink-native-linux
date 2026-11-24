#!/usr/bin/env python3
"""Deterministic patch-format regressions; no vendor files, accounts or network."""
import base64
import random
import unittest
from delta import apply_patch, literal_size, make_patch


class DeltaTests(unittest.TestCase):
    def test_small_changes_do_not_embed_whole_upstream(self):
        randomizer = random.Random(458)
        base = randomizer.randbytes(300000)
        target = b'new-prefix' + base[:45000] + b'changed-value' + base[45100:240000] + base[241000:] + b'new-tail'
        operations = make_patch(base, target)
        self.assertEqual(apply_patch(base, operations, len(target)), target)
        self.assertLess(literal_size(operations), 512)

    def test_binary_unicode_empty_and_repeated_sources(self):
        fixtures = [b'', bytes(range(256)) * 400, ('文本#"%_\0' * 300).encode(), b'x' * 8192]
        for base in fixtures:
            for target in [b'', b'new', base, base[:71] + b'\xff\0inserted' + base[83:]]:
                with self.subTest(base_length=len(base), target_length=len(target)):
                    self.assertEqual(apply_patch(base, make_patch(base, target), len(target)), target)

    def test_rejects_truncation_and_out_of_bounds(self):
        for operations, size in [([['copy', -1, 1]], 1), ([['copy', 1, 4]], 4),
                                 ([['copy', True, 1]], 1), ([['copy', 0, 1]], 2),
                                 ([['data', base64.b64encode(b'long').decode()]], 3),
                                 ([['data', '!not-base64!']], 1), ([['run', 'payload']], 0)]:
            with self.subTest(operations=operations):
                with self.assertRaises((ValueError, TypeError)):
                    apply_patch(b'base', operations, size)

    def test_separate_edits_preserve_intervening_bytes(self):
        base = (b'function a(x){return x+1;}\n' * 3000)
        target = base[:5000] + b'const linux=true;' + base[5000:35000] + b'/* native */' + base[35000:]
        self.assertEqual(apply_patch(base, make_patch(base, target), len(target)), target)


if __name__ == '__main__':
    unittest.main()
