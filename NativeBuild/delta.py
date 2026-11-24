#!/usr/bin/env python3
"""Small copy/literal patches: unchanged upstream bytes remain in the user's base."""
import base64

FORMAT = 'welink-copy-literal-v1'


def make_patch(base, target, block=64, stride=32):
    index = {}
    for offset in range(0, max(0, len(base) - block + 1), stride):
        key = base[offset:offset + block]
        positions = index.setdefault(key, [])
        if len(positions) < 16:
            positions.append(offset)
    operations = []
    position = 0
    literal = 0
    while position + block <= len(target):
        candidates = index.get(target[position:position + block], ())
        best_offset, best_length = 0, 0
        for offset in candidates:
            length = block
            limit = min(len(base) - offset, len(target) - position)
            while length + 4096 <= limit and base[offset + length:offset + length + 4096] == target[position + length:position + length + 4096]:
                length += 4096
            while length < limit and base[offset + length] == target[position + length]:
                length += 1
            if length > best_length:
                best_offset, best_length = offset, length
        if not best_length:
            position += 1
            continue
        if position > literal:
            operations.append(['data', base64.b64encode(target[literal:position]).decode('ascii')])
        if operations and operations[-1][0] == 'copy' and operations[-1][1] + operations[-1][2] == best_offset:
            operations[-1][2] += best_length
        else:
            operations.append(['copy', best_offset, best_length])
        position += best_length
        literal = position
    if literal < len(target):
        operations.append(['data', base64.b64encode(target[literal:]).decode('ascii')])
    return operations


def apply_patch(base, operations, size):
    if type(size) is not int or not 0 <= size <= 268435456 or not isinstance(operations, list):
        raise ValueError('Invalid patch size or operations')
    output = bytearray()
    for operation in operations:
        if not isinstance(operation, list) or not operation:
            raise ValueError('Invalid patch operation')
        if operation[0] == 'copy' and len(operation) == 3:
            offset, count = operation[1:]
            if type(offset) is not int or type(count) is not int or offset < 0 or count < 0 or offset + count > len(base):
                raise ValueError('Copy exceeds base file')
            if len(output) + count > size:
                raise ValueError('Patch exceeds target size')
            output.extend(base[offset:offset + count])
        elif operation[0] == 'data' and len(operation) == 2 and isinstance(operation[1], str):
            data = base64.b64decode(operation[1], validate=True)
            if len(output) + len(data) > size:
                raise ValueError('Literal exceeds target size')
            output.extend(data)
        else:
            raise ValueError('Unknown patch operation')
    if len(output) != size:
        raise ValueError('Incomplete patch')
    return bytes(output)


def literal_size(operations):
    return sum(len(base64.b64decode(op[1], validate=True)) for op in operations if op[0] == 'data')
