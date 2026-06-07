/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker;

import java.awt.Dimension;
import java.util.ArrayList;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JPanel;
import javax.swing.JTextField;

public class FloorTab
extends JPanel {
    private JButton btnFloortab;
    private JTextField txtFloorName;
    private String name;
    private NetworkCalculatorManagerInfo networkCalculatorManagerInfo;

    public FloorTab(String name) {
        this.name = name;
        this.btnFloortab = new JButton();
        this.btnFloortab.setText(name);
        this.txtFloorName = new JTextField();
        this.txtFloorName.setText(name);
        this.txtFloorName.setMaximumSize(new Dimension(300, this.txtFloorName.getMaximumSize().height));
        this.setLayout(new BoxLayout(this, 1));
        this.add(this.btnFloortab);
        this.add(this.txtFloorName);
        this.txtFloorName.setVisible(false);
        this.networkCalculatorManagerInfo = new NetworkCalculatorManagerInfo();
    }

    public JButton getBtnFloorTab() {
        return this.btnFloortab;
    }

    public JTextField getTxtFloorName() {
        return this.txtFloorName;
    }

    public void setFloorName(String FloorName) {
        this.txtFloorName.setText(FloorName);
        this.btnFloortab.setText(FloorName);
        this.name = FloorName;
    }

    public String getFloorName() {
        return this.name;
    }

    public NetworkCalculatorManagerInfo getNetworkCalculatorManagerInfo() {
        return this.networkCalculatorManagerInfo;
    }

    public class NetworkCalculatorManagerInfo {
        private String ErrorInfo = null;
        private boolean needsRecalc = false;
        private ArrayList<String> warningErrorInfo = new ArrayList();
        private boolean Interrupt = false;

        public void setNetworkCalculatorManagerInfo(boolean needsRecalc, String ErrorInfo, ArrayList<String> warningErrorInfo, boolean Interrupt) {
            this.needsRecalc = needsRecalc;
            this.ErrorInfo = ErrorInfo;
            this.warningErrorInfo = warningErrorInfo;
            this.Interrupt = Interrupt;
        }

        public String getErrorInfo() {
            return this.ErrorInfo;
        }

        public boolean getNeedsRecalc() {
            return this.needsRecalc;
        }

        public ArrayList<String> getWarningErrorInfo() {
            return this.warningErrorInfo;
        }

        public boolean getInterrupt() {
            return this.Interrupt;
        }
    }
}

