import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('simulator_launcher', Path(__file__).resolve().parents[1] / 'scripts/open_workspace.py')
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class SimulatorLauncherTests(unittest.TestCase):
    def test_reuse_upgraded_service_before_starting_another(self):
        with patch.object(launcher, 'healthy', side_effect=lambda port: port == 4290), patch.object(launcher, 'port_in_use') as occupied:
            self.assertEqual(launcher.select_port(), 4290)
            occupied.assert_not_called()

    def test_old_default_service_uses_free_alternative_without_termination(self):
        with patch.object(launcher, 'healthy', return_value=False), patch.object(launcher, 'port_in_use', side_effect=lambda port: port == 4287):
            self.assertEqual(launcher.select_port(), 4290)

    def test_no_service_uses_default_port(self):
        with patch.object(launcher, 'healthy', return_value=False), patch.object(launcher, 'port_in_use', return_value=False):
            self.assertEqual(launcher.select_port(), 4287)

    def test_two_old_services_use_second_alternative(self):
        with patch.object(launcher, 'healthy', return_value=False), patch.object(launcher, 'port_in_use', side_effect=lambda port: port in (4287, 4290)):
            self.assertEqual(launcher.select_port(), 4291)

    def test_reuse_qwen_service_before_free_older_ports(self):
        with patch.object(launcher, 'healthy', side_effect=lambda port: port == 4291), patch.object(launcher, 'port_in_use') as occupied:
            self.assertEqual(launcher.select_port(), 4291)
            occupied.assert_not_called()

    def test_health_requires_qwen_protocol_and_both_providers(self):
        upgraded = {'protocol': 'support-simulator-v2', 'rubricVersion': 'support-rubric-v2', 'connectionProtocol': 'support-providers-qwen-v1', 'providers': ['deepseek', 'qwen'], 'available': True, 'runtimeHash': launcher.runtime_hash()}
        checks = [
            (upgraded, True),
            ({'protocol': 'support-simulator-v2', 'rubric': {'version': 'support-rubric-v2'}}, False),
            ({**upgraded, 'connectionProtocol': 'old'}, False),
            ({**upgraded, 'providers': ['deepseek']}, False),
            ({**upgraded, 'available': False}, False),
            ({**upgraded, 'providers': None}, False),
            ({**upgraded, 'runtimeHash': 'previous-process-code'}, False),
        ]
        for simulator, expected in checks:
            with self.subTest(simulator=simulator), patch.object(launcher.urllib.request, 'build_opener') as factory:
                factory.return_value.open.side_effect = [io.StringIO(json.dumps({'protocol': 'aftersales-replay-v1', 'versions': []})), io.StringIO(json.dumps(simulator)), io.StringIO(json.dumps({'protocol': 'ontology-graph-v1', 'available': True, 'domainProtocol': 'ontology-domain-v1'}))]
                self.assertEqual(launcher.healthy(4291), expected)
                self.assertEqual(factory.return_value.open.call_args.args[0], 'http://127.0.0.1:4291/api/support/ontology/health')

    def test_previous_services_use_graph_ready_alternative_without_termination(self):
        with patch.object(launcher, 'healthy', return_value=False), patch.object(launcher, 'port_in_use', side_effect=lambda port: port in (4287, 4290, 4291)):
            self.assertEqual(launcher.select_port(), 4293)

    def test_service_without_ontology_health_is_not_reused(self):
        with patch.object(launcher.urllib.request, 'build_opener') as factory:
            factory.return_value.open.side_effect = [io.StringIO('{}'), io.StringIO('{}'), OSError('missing endpoint')]
            self.assertFalse(launcher.healthy(4291))

    def test_old_view_only_graph_is_not_reused_for_domain_workbench(self):
        simulator = {'protocol': 'support-simulator-v2', 'rubricVersion': 'support-rubric-v2', 'connectionProtocol': 'support-providers-qwen-v1', 'providers': ['deepseek', 'qwen'], 'available': True, 'runtimeHash': launcher.runtime_hash()}
        with patch.object(launcher.urllib.request, 'build_opener') as factory:
            factory.return_value.open.side_effect = [io.StringIO(json.dumps({'protocol': 'aftersales-replay-v1', 'versions': []})), io.StringIO(json.dumps(simulator)), io.StringIO(json.dumps({'protocol': 'ontology-graph-v1', 'available': True}))]
            self.assertFalse(launcher.healthy(4294))

    def test_occupied_ports_fail_without_killing_or_spawning(self):
        with patch.object(launcher, 'healthy', return_value=False), patch.object(launcher, 'port_in_use', return_value=True), patch.object(launcher.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, '未关闭任何进程'):
                launcher.select_port()
            spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
