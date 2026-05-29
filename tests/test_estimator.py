import unittest

from toki.estimator import estimate


class EstimatorTest(unittest.TestCase):
    def test_empty_string(self):
        est = estimate("")
        self.assertEqual(est.tokens, 0)
        self.assertEqual(est.words, 0)
        self.assertEqual(est.characters, 0)

    def test_whitespace_is_free(self):
        self.assertEqual(estimate("   \n\t  ").tokens, 0)

    def test_single_short_word_is_one_token(self):
        self.assertEqual(estimate("hi").tokens, 1)

    def test_long_word_splits_by_chars_per_token(self):
        # 8 latin chars -> ceil(8/4) = 2 tokens
        self.assertEqual(estimate("abcdefgh").tokens, 2)

    def test_word_count(self):
        est = estimate("the quick brown fox")
        self.assertEqual(est.words, 4)
        # the(3)->1, quick(5)->2, brown(5)->2, fox(3)->1 = 6
        self.assertEqual(est.tokens, 6)

    def test_punctuation_counts_per_char(self):
        # "hi" -> 1, then "!" "!" "!" -> 3 tokens
        self.assertEqual(estimate("hi!!!").tokens, 4)

    def test_cjk_counted_per_character(self):
        # 5 Japanese characters -> ~5 tokens, no latin
        est = estimate("こんにちは")
        self.assertEqual(est.tokens, 5)

    def test_mixed_cjk_and_latin_word(self):
        # "AI時代" -> latin "AI" (ceil(2/4)=1) + 2 CJK = 3 tokens
        self.assertEqual(estimate("AI時代").tokens, 3)

    def test_characters_counts_code_points(self):
        self.assertEqual(estimate("héllo").characters, 5)

    def test_apostrophe_word_stays_together(self):
        self.assertEqual(estimate("don't").words, 1)

    def test_as_dict_roundtrip(self):
        d = estimate("hello world").as_dict()
        self.assertEqual(set(d), {"tokens", "characters", "words"})


if __name__ == "__main__":
    unittest.main()
