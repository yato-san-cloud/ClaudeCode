/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.bms.model.Beacon;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.BeaconObject;
import java.awt.Dimension;
import java.awt.event.FocusAdapter;
import java.awt.event.FocusEvent;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JTextField;

public class BeaconEditor
extends AbstractObjectEditor<BeaconObject> {
    private static final long serialVersionUID = 1182448385476080383L;
    JTextField txtID;
    JTextField txtName;

    public BeaconEditor(BeaconObject editingObject, WorldMap map, MapMaker mapMaker) {
        super(editingObject, map, mapMaker);
    }

    @Override
    public void fillFormGUI(JPanel pnlForm) {
        JPanel pnlID = new JPanel();
        pnlID.setLayout(null);
        pnlID.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 60));
        JLabel lblTitle = new JLabel("■ビーコン設定");
        lblTitle.setBounds(20, 1, 200, 25);
        pnlID.add(lblTitle);
        JLabel lblID = new JLabel("ビーコンID");
        lblID.setBounds(33, 30, 80, 25);
        pnlID.add(lblID);
        this.txtID = new JTextField();
        this.txtID.setBounds(110, 30, 170, 25);
        this.txtID.setText(((BeaconObject)this.editingObject).beacon().beaconID);
        this.txtID.addFocusListener(new FocusAdapter(){

            @Override
            public void focusGained(FocusEvent arg0) {
                BeaconEditor.this.txtID.setSelectionStart(0);
                BeaconEditor.this.txtID.setSelectionEnd(BeaconEditor.this.txtID.getText().length());
            }

            @Override
            public void focusLost(FocusEvent e) {
                BeaconEditor.this.updateObjectFromGUI();
            }
        });
        this.txtID.addKeyListener(new KeyAdapter(){

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 9 || e.getKeyCode() == 10) {
                    BeaconEditor.this.updateObjectFromGUI();
                }
            }
        });
        pnlID.add(this.txtID);
        pnlForm.add(pnlID);
        JPanel pnlName = new JPanel();
        pnlName.setLayout(null);
        pnlName.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 40));
        JLabel lblName = new JLabel("ビーコン名");
        lblName.setBounds(33, 1, 80, 25);
        pnlName.add(lblName);
        this.txtName = new JTextField();
        this.txtName.setBounds(110, 1, 170, 25);
        this.txtName.setText(((BeaconObject)this.editingObject).beacon().beaconID);
        this.txtName.addFocusListener(new FocusAdapter(){

            @Override
            public void focusGained(FocusEvent arg0) {
                BeaconEditor.this.txtName.setSelectionStart(0);
                BeaconEditor.this.txtName.setSelectionEnd(BeaconEditor.this.txtName.getText().length());
            }

            @Override
            public void focusLost(FocusEvent e) {
                BeaconEditor.this.updateObjectFromGUI();
            }
        });
        this.txtName.addKeyListener(new KeyAdapter(){

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 9 || e.getKeyCode() == 10) {
                    BeaconEditor.this.updateObjectFromGUI();
                }
            }
        });
        pnlName.add(this.txtName);
        pnlForm.add(pnlName);
    }

    @Override
    protected void _updateGUIFromObject() {
        this.txtID.setText(((BeaconObject)this.editingObject).beacon().beaconID);
        this.txtName.setText(((BeaconObject)this.editingObject).beacon().beaconName);
    }

    @Override
    protected void _updateObjectFromGUI() {
        try {
            Beacon newBeacon = new Beacon(this.txtID.getText(), this.txtName.getText());
            newBeacon.setCoord(((BeaconObject)this.editingObject).point());
            ((BeaconObject)this.editingObject).setBeacon(newBeacon);
        }
        catch (Exception ex) {
            ex.printStackTrace();
        }
    }
}

