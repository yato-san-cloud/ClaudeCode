/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.editors.BeaconEditor;
import com.hitachi.warehouse.mapmaker.editors.ConstrainedAreaEditor;
import com.hitachi.warehouse.mapmaker.editors.ShelfEditor;
import com.hitachi.warehouse.mapmaker.editors.StairsEditor;
import com.hitachi.warehouse.mapmaker.editors.StationEditor;
import com.hitachi.warehouse.mapmaker.editors.WallEditor;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.BeaconObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.FlowLayout;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;

public abstract class AbstractObjectEditor<T extends AbstractObject>
extends JPanel {
    private static final long serialVersionUID = 7084134403262228559L;
    public final WorldMap map;
    public final T editingObject;
    public final MapMaker mapMaker;
    public JButton btnDelete;
    private boolean updatingGUI = false;
    boolean updatingObject = false;
    private List<ObjectEditorListener<T>> listeners = new ArrayList<ObjectEditorListener<T>>();

    public AbstractObjectEditor(T editingObject, WorldMap map, MapMaker mapMaker) {
        this.map = map;
        this.editingObject = editingObject;
        this.mapMaker = mapMaker;
        this.setLayout(new BorderLayout());
        JLabel lblTitle = new JLabel(editingObject.toString());
        lblTitle.setHorizontalAlignment(0);
        this.add((Component)lblTitle, "North");
        JPanel pnlForm = new JPanel();
        pnlForm.setLayout(new BoxLayout(pnlForm, 1));
        this.fillFormGUI(pnlForm);
        this.add((Component)pnlForm, "Center");
        JPanel pnlControl = new JPanel();
        pnlControl.setLayout(new FlowLayout());
        this.btnDelete = new JButton("Delete");
        if (((AbstractObject)editingObject).getEditLock()) {
            this.btnDelete.setEnabled(false);
        } else {
            this.btnDelete.setEnabled(true);
        }
        pnlControl.add(this.btnDelete);
        this.btnDelete.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                AbstractObjectEditor.this.dispatchDeleted();
            }
        });
        this.add((Component)pnlControl, "South");
        this.updateGUIFromObject();
    }

    public abstract void fillFormGUI(JPanel var1);

    protected abstract void _updateObjectFromGUI();

    protected abstract void _updateGUIFromObject();

    protected final void updateObjectFromGUI() {
        if (!this.updatingObject) {
            this.updatingGUI = true;
            this._updateObjectFromGUI();
            this.updatingGUI = false;
            this.updateGUIFromObject();
            this.dispatchObjectEdited();
        }
    }

    protected final void updateGUIFromObject() {
        if (!this.updatingGUI) {
            this.updatingObject = true;
            this._updateGUIFromObject();
            this.updatingObject = false;
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public ObjectEditorListener<T> addListener(ObjectEditorListener<T> listener) {
        List<ObjectEditorListener<T>> list = this.listeners;
        synchronized (list) {
            this.listeners.add(listener);
        }
        return listener;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void removeListener(ObjectEditorListener<T> listener) {
        List<ObjectEditorListener<T>> list = this.listeners;
        synchronized (list) {
            this.listeners.remove(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchObjectEdited() {
        List<ObjectEditorListener<T>> list = this.listeners;
        synchronized (list) {
            for (ObjectEditorListener<T> listener : this.listeners) {
                listener.objectEdited(this.editingObject);
            }
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchDeleted() {
        List<ObjectEditorListener<T>> list = this.listeners;
        synchronized (list) {
            for (ObjectEditorListener<T> listener : this.listeners) {
                listener.deleted();
            }
        }
    }

    public static <T extends AbstractObject> AbstractObjectEditor<T> openEditor(final T obj, final WorldMap map, final MapMaker mapMaker, HashMap<AbstractObject, Bound> selectedObjectsOriginalBound) {
        AbstractObjectEditor editor = null;
        if (WallObject.class.isInstance(obj)) {
            editor = new WallEditor((WallObject)obj, map, mapMaker);
        } else if (ConstrainedAreaObject.class.isInstance(obj)) {
            editor = new ConstrainedAreaEditor((ConstrainedAreaObject)obj, map, mapMaker);
        } else if (FreeShelfObject.class.isInstance(obj)) {
            editor = new ShelfEditor((FreeShelfObject)obj, map, mapMaker, selectedObjectsOriginalBound);
        } else if (BeaconObject.class.isInstance(obj)) {
            editor = new BeaconEditor((BeaconObject)obj, map, mapMaker);
        } else if (StationObject.class.isInstance(obj)) {
            editor = new StationEditor((StationObject)obj, map, mapMaker);
        } else if (StairsObject.class.isInstance(obj)) {
            editor = new StairsEditor((StairsObject)obj, map, mapMaker);
        }
        if (editor != null) {
            editor.addListener(new ObjectEditorListener<T>(){

                @Override
                public void objectEdited(T obj2) {
                    map.dispatchChangedEvent();
                }

                @Override
                public void deleted() {
                    if (map != null) {
                        try {
                            map.startWrite();
                            map.remove(obj);
                            mapMaker.showInfoForObject(null, null);
                        }
                        finally {
                            map.endWrite();
                        }
                    }
                }
            });
        }
        return editor;
    }

    public static interface ObjectEditorListener<T extends AbstractObject> {
        public void objectEdited(T var1);

        public void deleted();
    }
}

