import io
import json
import os
import unittest
import urllib.error
from unittest import mock

import handler

QUESTIONS = {
    "urgent": {"type": "noul", "instructions": "Is this support request urgent?"},
    "team": {"type": "choice", "criteria": {"billing": "Payments", "technical": "Outages"}},
}
ANSWER = {
    "model": "clef",
    "answers": {
        "urgent": {"type": "noul", "noul": 0.97},
        "team": {
            "type": "choice",
            "choice": "technical",
            "confidence": 0.9,
            "probabilities": {"billing": 0.05, "technical": 0.95},
        },
    },
    "usage": {"input_tokens": 50, "output_tokens": 2},
}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class BuildRequestTest(unittest.TestCase):
    def test_uses_the_ollama_model_and_forwards_state_and_questions(self):
        body = handler.build_request(
            {"model": "risk-check", "state": "Checkout is down", "questions": QUESTIONS}, "clef"
        )
        self.assertEqual(body, {"model": "clef", "state": "Checkout is down", "questions": QUESTIONS})

    def test_images_are_forwarded_only_when_given(self):
        body = handler.build_request(
            {"state": {}, "questions": QUESTIONS, "images": ["iVBORw0KGgo="]}, "clef"
        )
        self.assertEqual(body["images"], ["iVBORw0KGgo="])
        self.assertNotIn("images", handler.build_request({"state": {}, "questions": QUESTIONS}, "clef"))

    def test_rejects_requests_without_state_or_questions(self):
        for job_input, message in [
            (None, "input must be an object"),
            ({"questions": QUESTIONS}, "input.state is required"),
            ({"state": "x"}, "input.questions must be a non-empty object"),
            ({"state": "x", "questions": {}}, "input.questions must be a non-empty object"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                handler.build_request(job_input, "clef")


class DecideTest(unittest.TestCase):
    def test_posts_json_to_ollama_and_returns_the_response(self):
        sent = {}

        def opener(request, timeout):
            sent.update(url=request.full_url, method=request.get_method(), body=json.loads(request.data))
            sent["timeout"] = timeout
            return FakeResponse(json.dumps(ANSWER).encode())

        result = handler.decide({"state": "x", "questions": QUESTIONS}, "clef", opener=opener)
        self.assertEqual(result, ANSWER)
        self.assertEqual(sent["url"], "http://127.0.0.1:11434/v1/systemone")
        self.assertEqual(sent["method"], "POST")
        self.assertEqual(sent["body"]["model"], "clef")
        self.assertEqual(sent["timeout"], 600)


@mock.patch.dict(os.environ, {"MODEL_NAME": "clef"})
class HandlerTest(unittest.TestCase):
    def test_returns_the_decision_as_the_job_output(self):
        result = handler.handler(
            {"input": {"state": "x", "questions": QUESTIONS}}, decide_fn=lambda i, m: ANSWER
        )
        self.assertEqual(result, ANSWER)

    def test_invalid_input_fails_the_job(self):
        self.assertEqual(
            handler.handler({"input": {"state": "x"}}),
            {"error": "input.questions must be a non-empty object"},
        )

    def test_ollama_errors_fail_the_job(self):
        def http_error(i, m):
            raise urllib.error.HTTPError("u", 400, "Bad Request", {}, io.BytesIO(b"unknown model"))

        def unreachable(i, m):
            raise urllib.error.URLError("connection refused")

        self.assertEqual(
            handler.handler({"input": {}}, decide_fn=http_error),
            {"error": "ollama returned HTTP 400: unknown model"},
        )
        self.assertEqual(
            handler.handler({"input": {}}, decide_fn=unreachable),
            {"error": "ollama is not reachable: connection refused"},
        )


if __name__ == "__main__":
    unittest.main()
