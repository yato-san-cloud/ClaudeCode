/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.OperationMode;
import java.awt.Color;
import java.awt.Insets;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JPanel;
import javax.swing.JToolBar;

public class OperationModeToolBar
extends JToolBar {
    private static final long serialVersionUID = -3896431840967337437L;
    private MapMaker mapMaker;
    private JPanel pnlModeButtons;
    private JButton btnStartNetworkGenerator;
    private List<OperationMode> modeOrder = new ArrayList<OperationMode>();
    private List<JButton> buttons = new ArrayList<JButton>();
    HashMap<JButton, OperationMode> modeForButton = new HashMap();

    public OperationModeToolBar(MapMaker _mapMaker) {
        this.mapMaker = _mapMaker;
        JPanel pnlAll = new JPanel();
        pnlAll.setLayout(new BoxLayout(pnlAll, 0));
        this.pnlModeButtons = new JPanel();
        this.pnlModeButtons.setLayout(new BoxLayout(this.pnlModeButtons, 0));
        this.addOperationButton("編集", OperationMode.kEditRect);
        this.addOperationButton("表示", OperationMode.kView);
        this.addOperationButton("追加：棚", OperationMode.kAddShelf);
        this.addOperationButton("追加：壁", OperationMode.kAddWall);
        this.addOperationButton("追加：検品場", OperationMode.kAddStation);
        this.addOperationButton("追加：制約領域", OperationMode.kAddConstrainedArea);
        this.addOperationButton("追加：階段", OperationMode.kAddStairs);
        this.addOperationButton("ビーコン", OperationMode.kEditBeacon);
        this.addOperationButton("経路表示", OperationMode.kRulerCart);
        this.addOperationButton("デバッグ", OperationMode.kDebug);
        this.addOperationButton("倉庫サイズ変更", OperationMode.kDistanceSet);
        pnlAll.add(this.pnlModeButtons);
        this.btnStartNetworkGenerator = new JButton("経路キャッシュ計算");
        this.btnStartNetworkGenerator.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent arg0) {
                if (OperationModeToolBar.this.mapMaker.getCalculatorManager().isCalculating()) {
                    OperationModeToolBar.this.mapMaker.getCalculatorManager().setGeneratorNeedsInterrupt(true);
                    OperationModeToolBar.this.mapMaker.getCalculatorManager().recalc();
                } else {
                    OperationModeToolBar.this.mapMaker.getCalculatorManager().setCalculationCheck_run(true);
                }
            }
        });
        this.btnStartNetworkGenerator.setMargin(new Insets(2, 2, 2, 2));
        pnlAll.add(this.btnStartNetworkGenerator);
        this.add(pnlAll);
        this.setFloatable(true);
    }

    public JButton getbtnStartNetworkGenerator() {
        return this.btnStartNetworkGenerator;
    }

    public OperationMode modeAtIdx(int idx) {
        if (idx >= 0 && idx < this.modeOrder.size()) {
            return this.modeOrder.get(idx);
        }
        return null;
    }

    private void addOperationButton(String name, OperationMode mode) {
        this.modeOrder.add(mode);
        this.pnlModeButtons.add(this.createButton(name, mode));
    }

    public JButton createButton(String title, final OperationMode mode) {
        JButton btnViewMode = new JButton(title);
        btnViewMode.setMargin(new Insets(2, 7, 2, 7));
        btnViewMode.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                OperationModeToolBar.this.mapMaker.setOperationMode(mode);
            }
        });
        this.buttons.add(btnViewMode);
        this.modeForButton.put(btnViewMode, mode);
        return btnViewMode;
    }

    public void selectButton(Object btn) {
        for (JButton other : this.buttons) {
            if (other != btn) {
                other.setBackground(Color.WHITE);
                other.setSelected(false);
                continue;
            }
            other.setBackground(Color.GRAY);
            other.setSelected(true);
            this.mapMaker.setOperationMode(this.modeForButton.get(other));
        }
    }

    public void updateStatus() {
        for (JButton other : this.buttons) {
            if (this.modeForButton.get(other) == this.mapMaker.mode()) {
                other.setBackground(Color.GRAY);
                other.setSelected(true);
                continue;
            }
            other.setBackground(Color.WHITE);
            other.setSelected(false);
        }
    }
}

