import unittest
from grounding import stack_intent, stack_reply

class StackIntentTests(unittest.TestCase):
    def test_wei_call_questions_hit(self):
        # Verbatim from live call 4B927E01 (2026-11-16), where the LLM
        # answered both with evasions ('no update notice', 'no updates').
        self.assertTrue(stack_intent('你现在模型换成功了吗'))
        self.assertTrue(stack_intent('你最近更新了什么'))

    def test_english_variants_hit(self):
        self.assertTrue(stack_intent('did you switch the model successfully?'))
        self.assertTrue(stack_intent('are you running on the 4090 now'))
        self.assertTrue(stack_intent('what did you update'))

    def test_unrelated_questions_miss(self):
        self.assertFalse(stack_intent('你好'))
        self.assertFalse(stack_intent('Can you speak French?'))
        self.assertFalse(stack_intent('what is a language model'))
        self.assertFalse(stack_intent('你最近怎么样'))

    def test_reply_language_follows_caller(self):
        self.assertIn('4090', stack_reply('你现在模型换成功了吗'))
        self.assertIn('换成功了', stack_reply('你现在模型换成功了吗'))
        self.assertIn('4090', stack_reply('did the switch work'))

if __name__ == '__main__':
    unittest.main()
