#!/usr/bin/env python3
"""Remap portable workflow/credential IDs into copies, without changing sources."""
import argparse
import json
from pathlib import Path


def prepare(source, output, mapping):
    ids = mapping.get('workflow_ids', {})
    credential = mapping['postgres_credential']
    if set(ids) != {f'disCoreWF0{i}' for i in range(5)}:
        raise ValueError('workflow_ids must contain all five portable IDs')
    if len(set(ids.values())) != 5 or not all(isinstance(v, str) and v for v in ids.values()):
        raise ValueError('workflow IDs must be distinct, nonempty strings')
    output.mkdir(parents=True, exist_ok=True)
    for path in sorted(source.glob('WF-*.json')):
        workflow = json.loads(path.read_text())
        workflow['id'] = ids[workflow['id']]
        for node in workflow['nodes']:
            if node['type'] == 'n8n-nodes-base.executeWorkflow':
                node['parameters']['workflowId']['value'] = ids[node['parameters']['workflowId']['value']]
            if node['type'] == 'n8n-nodes-base.postgres':
                node['credentials']['postgres'] = credential
            if node['type'] == 'n8n-nodes-base.webhook' and 'webhook_path' in mapping:
                node['parameters']['path'] = mapping['webhook_path']
        (output / path.name).write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mapping', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'workflows')
    args = parser.parse_args()
    prepare(args.source, args.output, json.loads(args.mapping.read_text()))
