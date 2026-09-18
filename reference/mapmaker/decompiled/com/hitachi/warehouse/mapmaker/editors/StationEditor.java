/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.StationObject;
import javax.swing.JPanel;

public class StationEditor
extends AbstractObjectEditor<StationObject> {
    public StationEditor(StationObject editingObject, WorldMap map, MapMaker mapMaker) {
        super(editingObject, map, mapMaker);
    }

    @Override
    public void fillFormGUI(JPanel pnlForm) {
    }

    @Override
    protected void _updateObjectFromGUI() {
    }

    @Override
    protected void _updateGUIFromObject() {
    }
}

