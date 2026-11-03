#!/usr/bin/env python3
"""Remap portable workflow/credential IDs into copies, without changing sources.

Trusted contract (post-hardening): WF-00 verifies internal HMAC before normalization/reservation.
The JSON authenticated_source flag alone is never trusted.
The n8n webhook must stay loopback/private; public entry is the ingress service.
"""
import argparse
import json
from pathlib import Path

REQUIRED_IDS = {f'disCoreWF0{i}' for i in range(5)}
PRIVATE_EXPOSURE = {'loopback_only', 'private', '127.0.0.1', 'localhost'}


def prepare(source, output, mapping):
    ids = mapping.get('workflow_ids', {})
    credential = mapping['postgres_credential']
    if set(ids) != REQUIRED_IDS:
        raise ValueError('workflow_ids must contain all five portable IDs')
    if len(set(ids.values())) != 5 or not all(isinstance(v, str) and v for v in ids.values()):
        raise ValueError('workflow IDs must be distinct, nonempty strings')

    exposure = mapping.get('webhook_exposure', 'loopback_only')
    if exposure not in PRIVATE_EXPOSURE:
        raise ValueError(
            'webhook_exposure must be loopback_only/private; '
            'do not publish the n8n webhook beyond the private contour'
        )
    if mapping.get('ingress_required') is False:
        raise ValueError('ingress_required cannot be false after scoped-ingress hardening')

    output.mkdir(parents=True, exist_ok=True)
    for path in sorted(source.glob('WF-*.json')):
        workflow = json.loads(path.read_text(encoding='utf-8'))
        workflow['id'] = ids[workflow['id']]
        for node in workflow['nodes']:
            if node['type'] == 'n8n-nodes-base.executeWorkflow':
                node['parameters']['workflowId']['value'] = ids[node['parameters']['workflowId']['value']]
            if node['type'] == 'n8n-nodes-base.postgres':
                node['credentials']['postgres'] = credential
            if node['type'] == 'n8n-nodes-base.webhook' and 'webhook_path' in mapping:
                node['parameters']['path'] = mapping['webhook_path']
        (output / path.name).write_text(
            json.dumps(workflow, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8',
        )

    contract = {
        'internal_proof': {'algorithm':'HMAC-SHA256', 'key_runtime_env':'DIS_GATEWAY_HMAC_KEY', 'max_age_seconds':300, 'headers':['x-dis-proof-time','x-dis-proof']},
        'ingress_required': True,
        'webhook_exposure': exposure,
        'required_fields': [
            'ingress.authenticated_source',
            'channel',
            'project_id',
            'bot_id',
            'external_event_id',
            'dialogue_id',
            'user_id',
        ],
        'event_id_format': 'channel|project_id|bot_id|external_event_id',
        'note': 'Client-supplied project_id/bot_id/channel must match ingress source binding.',
    }
    (output / 'INGRESS_CONTRACT.json').write_text(
        json.dumps(contract, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mapping', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'workflows')
    args = parser.parse_args()
    prepare(args.source, args.output, json.loads(args.mapping.read_text(encoding='utf-8')))
