import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from toki.cli import main


class CliTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _write(self, name, content):
        path = os.path.join(self._tmp.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
        return path

    def test_single_file_table(self):
        path = self._write("a.txt", "the quick brown fox")
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([path])
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertIn("TOKENS", text)
        self.assertIn("4", text)

    def test_multiple_files_have_total(self):
        a = self._write("a.txt", "hello")
        b = self._write("b.txt", "world")
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([a, b])
        self.assertEqual(code, 0)
        self.assertIn("TOTAL", out.getvalue())

    def test_json_output(self):
        path = self._write("a.txt", "hello world")
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["--json", path])
        self.assertEqual(code, 0)
        data = json.loads(out.getvalue())
        self.assertEqual(data[path]["words"], 2)

    def test_missing_file_reports_error_and_exit_1(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main([os.path.join(self._tmp.name, "nope.txt")])
        self.assertEqual(code, 1)
        self.assertIn("toki:", err.getvalue())


if __name__ == "__main__":
    unittest.main()
