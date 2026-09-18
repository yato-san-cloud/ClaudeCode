"""whsim -- a warehouse simulator that is easy to model and heavy underneath.

The whole system hangs off one contract: the canonical warehouse-model schema
(``whsim.schema.WarehouseModel``). Templates, the ZIP importer, the SimPy
engine, the KPI layer and the renderers all read and write that single
structure, which keeps every component independently testable and replaceable.
"""

__version__ = "0.1.0"
