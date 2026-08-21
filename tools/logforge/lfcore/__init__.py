"""log-forge core: WMS actuals -> WHSIM_CONTRACTS v1.0 inputs.

Public surface used by the CLI and the tests:

    from lfcore.convert import convert, convert_to_dir
    from lfcore.validate import validate_dir, validate_result
    from lfcore.synth import generate

This package intentionally does not import WHSiM: log-forge is a standalone
converter and its only contract with the simulator is the file format.
"""

__version__ = "0.1.0"
